import crypto from "node:crypto";
import Account from "../accounts/account.model.js";
import Customer from "../customers/customer.model.js";
import Payment from "../models/payment.model.js";
import boss from "../config/boss.js";
import { getTradingConnector } from "../connectors/trading/registry.js";
import TradingCredentialSecret from "./trading-credential-secret.model.js";
import { enqueueTradingCredentialEmail } from "../workers/trading-credential-email.queue.js";

function encryptionKey() {
  const raw = String(process.env.TRADING_CREDENTIAL_ENCRYPTION_KEY || "").trim();
  if (!raw) return null;

  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");

  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // Fall through to invalid key error.
  }

  const error = new Error("TRADING_CREDENTIAL_ENCRYPTION_KEY must be 32 bytes encoded as base64 or 64 hex characters.");
  error.code = "TRADING_CREDENTIAL_KEY_INVALID";
  throw error;
}

export function tradingCredentialsConfigured() {
  try { return Boolean(encryptionKey()); }
  catch { return false; }
}

function encryptPassword(password) {
  const key = encryptionKey();
  if (!key) {
    const error = new Error("Trading credential encryption is not configured.");
    error.code = "TRADING_CREDENTIALS_NOT_CONFIGURED";
    throw error;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(password), "utf8"), cipher.final()]);
  return {
    encryptedPassword: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptPassword(record) {
  const key = encryptionKey();
  if (!key) {
    const error = new Error("Trading credential encryption is not configured.");
    error.status = 503;
    error.code = "TRADING_CREDENTIALS_NOT_CONFIGURED";
    throw error;
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.encryptedPassword, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function ownershipQuery(customer) {
  const customerIds = [...new Set([customer.customerId, ...(customer.customerIds || [])].filter(Boolean))];
  const legacyRefs = [...new Set([customer.id, customer.email, ...customerIds].filter(Boolean))];
  return {
    $or: [
      { customerId: { $in: customerIds } },
      { ownerExternalRef: { $in: legacyRefs } },
    ],
  };
}

function currentPlatformAccount(account) {
  const currentPhase = Number(account.currentPhase || 1);
  if (account.status === "FUNDED") {
    return (account.platformAccounts || []).find(item =>
      String(item.accountType || "").toUpperCase() === "FUNDED" && item.status === "ACTIVE"
    ) || null;
  }
  return (account.platformAccounts || []).find(item =>
    Number(item.phase) === currentPhase
    && String(item.accountType || "CHALLENGE").toUpperCase() !== "FUNDED"
    && item.status === "ACTIVE"
  ) || null;
}

async function resolveDeliveryEmail(account, explicitEmail = null) {
  const provided = String(explicitEmail || "").trim().toLowerCase();
  if (provided) return provided;

  if (account.customerId) {
    const customer = await Customer.findOne({ customerId: account.customerId }).select("primaryEmail").lean();
    if (customer?.primaryEmail) return String(customer.primaryEmail).trim().toLowerCase();
  }

  const payment = await Payment.findOne({ accountId: account.accountId }).select("email").lean();
  if (payment?.email) return String(payment.email).trim().toLowerCase();
  return null;
}

export async function ensureTradingCredential(account, { email = null, rotate = false, queueEmail = true, platformAccountId: platformAccountIdOverride = null } = {}) {
  if (!account || account.platform !== "acg-trader") return { skipped: true, reason: "provider" };
  if (!tradingCredentialsConfigured()) return { skipped: true, reason: "not-configured" };

  const platform = currentPlatformAccount(account);
  const platformAccountId = String(platformAccountIdOverride || platform?.platformAccountId || account.platformAccountId || "").trim();
  if (!platformAccountId) return { skipped: true, reason: "platform-account-missing" };

  const existing = await TradingCredentialSecret.findOne({ platformAccountId });
  if (existing && !rotate) {
    if (queueEmail && existing.delivery?.status !== "SENT") {
      const deliveryEmail = existing.deliveryEmail || await resolveDeliveryEmail(account, email);
      if (deliveryEmail) {
        existing.deliveryEmail = deliveryEmail;
        existing.delivery.status = "PENDING";
        existing.delivery.error = null;
        await existing.save();
        await enqueueTradingCredentialEmail(boss, existing._id);
      }
    }
    return { created: false, login: existing.login, credentialSecretId: String(existing._id) };
  }

  const connector = getTradingConnector("acg-trader");
  let result;
  try {
    result = await connector.createNativeCredential({ platformAccountId, rotate: Boolean(rotate) });
  } catch (error) {
    // Existing remote credentials with no ACG Funded vault copy cannot be
    // recovered because ACG Trader stores only a password hash. Rotate once
    // to establish a recoverable dashboard/email credential.
    if (!rotate && Number(error?.status) === 409 && !existing) {
      result = await connector.createNativeCredential({ platformAccountId, rotate: true });
      rotate = true;
    } else {
      throw error;
    }
  }

  if (!result?.login || !result?.temporaryPassword) {
    const error = new Error("ACG Trader did not return native trading credentials.");
    error.code = "TRADING_CREDENTIAL_INVALID_RESPONSE";
    throw error;
  }

  const encrypted = encryptPassword(result.temporaryPassword);
  const deliveryEmail = await resolveDeliveryEmail(account, email);

  const record = existing || new TradingCredentialSecret({
    accountId: account.accountId,
    platformAccountId,
    provider: "acg-trader",
  });
  record.accountId = account.accountId;
  record.login = String(result.login);
  record.encryptedPassword = encrypted.encryptedPassword;
  record.iv = encrypted.iv;
  record.authTag = encrypted.authTag;
  record.keyVersion = "v1";
  record.deliveryEmail = deliveryEmail || null;
  record.delivery = {
    status: queueEmail && deliveryEmail ? "PENDING" : "NOT_QUEUED",
    attempts: existing?.delivery?.attempts || 0,
    lastAttemptAt: existing?.delivery?.lastAttemptAt || null,
    sentAt: null,
    error: null,
  };
  if (rotate) record.rotatedAt = new Date();
  await record.save();

  const matchingPlatformRecord = (account.platformAccounts || []).find(item => String(item.platformAccountId || "") === platformAccountId);
  if (matchingPlatformRecord) matchingPlatformRecord.login = String(result.login);
  account.platformLogin = String(result.login);
  if (/^\d+$/.test(String(result.login))) account.login = Number(result.login);
  await account.save();

  if (queueEmail && deliveryEmail) await enqueueTradingCredentialEmail(boss, record._id);

  return {
    created: !existing,
    rotated: Boolean(rotate),
    login: record.login,
    credentialSecretId: String(record._id),
  };
}

export async function getCustomerTradingCredential(customer, accountId, { reveal = false } = {}) {
  const account = await Account.findOne({ accountId: String(accountId), ...ownershipQuery(customer) });
  if (!account) {
    const error = new Error("Trading account not found.");
    error.status = 404;
    throw error;
  }
  if (account.platform !== "acg-trader") {
    const error = new Error("This account is not provisioned on ACG Trader.");
    error.status = 409;
    throw error;
  }

  const platform = currentPlatformAccount(account);
  const platformAccountId = String(platform?.platformAccountId || account.platformAccountId || "").trim();
  if (!platformAccountId) {
    const error = new Error("Trading platform account is not ready.");
    error.status = 409;
    throw error;
  }

  let record = await TradingCredentialSecret.findOne({ platformAccountId });
  if (!record && tradingCredentialsConfigured()) {
    await ensureTradingCredential(account, { email: customer.email, queueEmail: true });
    record = await TradingCredentialSecret.findOne({ platformAccountId });
  }

  if (!record) {
    return {
      accountId: account.accountId,
      available: false,
      login: platform?.login || account.platformLogin || null,
      platform: "ACG Trader",
    };
  }

  return {
    accountId: account.accountId,
    available: true,
    login: record.login,
    password: reveal ? decryptPassword(record) : undefined,
    platform: "ACG Trader",
    deliveryStatus: record.delivery?.status || "NOT_QUEUED",
    updatedAt: record.updatedAt,
  };
}

export async function rotateCustomerTradingCredential(customer, accountId) {
  const account = await Account.findOne({ accountId: String(accountId), ...ownershipQuery(customer) });
  if (!account) {
    const error = new Error("Trading account not found.");
    error.status = 404;
    throw error;
  }
  await ensureTradingCredential(account, { email: customer.email, rotate: true, queueEmail: true });
  return getCustomerTradingCredential(customer, accountId, { reveal: true });
}

export function revealStoredPassword(record) {
  return decryptPassword(record);
}
