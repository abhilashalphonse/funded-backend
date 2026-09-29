import crypto from "node:crypto";

export const SUPPORTED_USDT_NETWORKS = Object.freeze(["TRC20"]);

function encryptionKey() {
  const raw = String(process.env.PAYOUT_DESTINATION_ENCRYPTION_KEY || "").trim();
  if (!raw) return null;

  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");

  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // Fall through to the configuration error below.
  }

  const error = new Error("PAYOUT_DESTINATION_ENCRYPTION_KEY must be 32 bytes encoded as base64 or 64 hex characters.");
  error.status = 503;
  error.code = "PAYOUT_DESTINATION_KEY_INVALID";
  throw error;
}

export function payoutDestinationEncryptionConfigured() {
  try { return Boolean(encryptionKey()); }
  catch { return false; }
}

function validationError(message, code = "INVALID_PAYOUT_DESTINATION") {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function normalizedName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 100) {
    throw validationError("Account holder name must be between 2 and 100 characters.");
  }
  return name;
}

function normalizeUpiDestination(input = {}) {
  const upiId = String(input.upiId || "").trim();
  if (!/^[A-Za-z0-9._-]{2,128}@[A-Za-z0-9._-]{2,64}$/.test(upiId)) {
    throw validationError("Enter a valid UPI ID.", "INVALID_UPI_ID");
  }

  const beneficiaryName = normalizedName(input.beneficiaryName);
  const [handle, provider] = upiId.split("@");
  const visible = handle.length <= 2 ? handle[0] || "*" : handle.slice(0, 2);

  return {
    payload: {
      method: "UPI",
      upiId,
      beneficiaryName,
    },
    masked: {
      method: "UPI",
      label: "UPI",
      destination: `${visible}***@${provider}`,
      beneficiaryName,
    },
  };
}

function normalizeBankDestination(input = {}) {
  const beneficiaryName = normalizedName(input.beneficiaryName);
  const rawAccountNumber = String(input.accountNumber || "").trim();
  const accountNumber = rawAccountNumber.replace(/\s+/g, "");
  if (!/^\d{6,20}$/.test(accountNumber)) {
    throw validationError("Enter a valid bank account number.", "INVALID_BANK_ACCOUNT");
  }

  const ifsc = String(input.ifsc || "").trim().toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
    throw validationError("Enter a valid IFSC code.", "INVALID_IFSC");
  }

  const bankName = String(input.bankName || "").trim().replace(/\s+/g, " ").slice(0, 100) || null;

  return {
    payload: {
      method: "BANK",
      beneficiaryName,
      accountNumber,
      ifsc,
      bankName,
    },
    masked: {
      method: "BANK",
      label: bankName || "Bank Transfer",
      destination: `•••• ${accountNumber.slice(-4)}`,
      beneficiaryName,
      ifsc,
    },
  };
}

function normalizeUsdtDestination(input = {}) {
  const network = String(input.network || "").trim().toUpperCase();
  if (!SUPPORTED_USDT_NETWORKS.includes(network)) {
    throw validationError(
      `USDT network must be one of: ${SUPPORTED_USDT_NETWORKS.join(", ")}.`,
      "UNSUPPORTED_USDT_NETWORK",
    );
  }

  const walletAddress = String(input.walletAddress || "").trim();
  if (network === "TRC20" && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(walletAddress)) {
    throw validationError("Enter a valid TRC20 wallet address.", "INVALID_USDT_WALLET");
  }

  return {
    payload: {
      method: "USDT",
      network,
      walletAddress,
    },
    masked: {
      method: "USDT",
      label: `USDT · ${network}`,
      destination: `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`,
      network,
    },
  };
}

export function normalizePayoutDestination(method, input = {}) {
  const normalizedMethod = String(method || "").trim().toUpperCase();
  if (normalizedMethod === "UPI") return normalizeUpiDestination(input);
  if (normalizedMethod === "BANK") return normalizeBankDestination(input);
  if (normalizedMethod === "USDT") return normalizeUsdtDestination(input);
  throw validationError("Unsupported payout method.", "UNSUPPORTED_PAYOUT_METHOD");
}

export function encryptPayoutDestination(payload) {
  const key = encryptionKey();
  if (!key) {
    const error = new Error("Payout destination encryption is not configured.");
    error.status = 503;
    error.code = "PAYOUT_DESTINATION_ENCRYPTION_NOT_CONFIGURED";
    throw error;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);

  return {
    destinationEncrypted: encrypted.toString("base64"),
    destinationIv: iv.toString("base64"),
    destinationAuthTag: cipher.getAuthTag().toString("base64"),
    destinationKeyVersion: "v1",
  };
}

export function decryptPayoutDestination(record) {
  const key = encryptionKey();
  if (!key) {
    const error = new Error("Payout destination encryption is not configured.");
    error.status = 503;
    error.code = "PAYOUT_DESTINATION_ENCRYPTION_NOT_CONFIGURED";
    throw error;
  }

  const encrypted = String(record?.destinationEncrypted || "");
  const iv = String(record?.destinationIv || "");
  const authTag = String(record?.destinationAuthTag || "");
  if (!encrypted || !iv || !authTag) {
    const error = new Error("Encrypted payout destination is unavailable.");
    error.status = 500;
    error.code = "PAYOUT_DESTINATION_UNAVAILABLE";
    throw error;
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64")),
    decipher.final(),
  ]).toString("utf8");

  return JSON.parse(plaintext);
}
