import Account from "../../accounts/account.model.js";
import Customer from "../../customers/customer.model.js";
import { getTradingConnector } from "../../connectors/trading/registry.js";

export const CUSTOMER_ACCESS_TERMINAL_ACCOUNT_STATUSES = Object.freeze(["BREACHED", "EXPIRED", "CLOSED"]);

const TRADABLE_ACCOUNT_STATUSES = new Set(["ACTIVE", "PHASE_2", "FUNDED"]);
const TERMINAL_PLATFORM_STATUSES = new Set(["BREACHED", "CLOSED", "DISABLED", "COMPLETED"]);

function ownershipIds(values = []) {
  return [...new Set((values || []).map(value => String(value || "").trim()).filter(Boolean))];
}

function currentPlatformRecord(account) {
  return (account?.platformAccounts || []).find(item =>
    String(item?.platformAccountId || "") === String(account?.platformAccountId || "")
  ) || null;
}

function customerBlockedError(code, message) {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  return error;
}

export async function assertCustomerTradingAccessAllowed(account, {
  customerModel = Customer,
  code = "CUSTOMER_BLOCKED_DURING_TRADING_ACTIVATION",
  message = "Customer is blocked from trading.",
} = {}) {
  if (account?.customerAccessBlocked === true) {
    throw customerBlockedError(code, message);
  }

  const customerId = String(account?.customerId || "").trim();
  if (!customerId) return true;

  const customer = await customerModel.findOne({ customerId }).select("status").lean();
  if (String(customer?.status || "").toUpperCase() === "BLOCKED") {
    throw customerBlockedError(code, message);
  }
  return true;
}

export async function blockCustomerTradingAccounts(rawOwnershipIds, {
  accountModel = Account,
  connectorResolver = getTradingConnector,
} = {}) {
  const ids = ownershipIds(rawOwnershipIds);
  if (!ids.length) return { accountsFlagged: 0, platformErrors: [] };

  const scope = {
    customerId: { $in: ids },
    status: { $nin: [...CUSTOMER_ACCESS_TERMINAL_ACCOUNT_STATUSES] },
  };

  // Durable local denial comes first. Any concurrent activation CAS now fails
  // even if its remote activation request is already in flight.
  const durable = await accountModel.updateMany(
    scope,
    { $set: { customerAccessBlocked: true, enabled: false } },
  );

  const accounts = await accountModel.find({
    ...scope,
    customerAccessBlocked: true,
  });

  const platformErrors = [];
  for (const account of accounts) {
    const platformAccountId = String(account?.platformAccountId || "").trim();
    if (!platformAccountId) continue;

    const record = currentPlatformRecord(account);
    const platformStatus = String(record?.status || "").toUpperCase();
    if (platformStatus === "PAUSED" || TERMINAL_PLATFORM_STATUSES.has(platformStatus)) continue;

    try {
      const connector = connectorResolver(account.platform);
      await connector.pauseAccount({
        externalRef: account.accountId,
        platformAccountId,
        reason: "ACG_FUNDED_CUSTOMER_BLOCKED",
        cancelPending: true,
      });
      if (record) record.status = "PAUSED";
      await account.save();
    } catch (error) {
      platformErrors.push({
        accountId: account.accountId,
        message: String(error?.message || error),
      });
    }
  }

  return {
    accountsFlagged: Number(durable?.matchedCount ?? durable?.n ?? 0),
    platformErrors,
  };
}

export async function reactivateCustomerTradingAccounts(rawOwnershipIds, {
  accountModel = Account,
  connectorResolver = getTradingConnector,
} = {}) {
  const ids = ownershipIds(rawOwnershipIds);
  if (!ids.length) return { platformErrors: [] };

  const accounts = await accountModel.find({
    customerId: { $in: ids },
    customerAccessBlocked: true,
  });

  const platformErrors = [];
  for (const account of accounts) {
    const status = String(account?.status || "").toUpperCase();
    const platformAccountId = String(account?.platformAccountId || "").trim();

    // Transitional/review/admin-locked accounts must remain non-tradable.
    // Clearing the customer block lets their own lifecycle command decide what
    // happens next instead of blindly resuming a remote account.
    if (!TRADABLE_ACCOUNT_STATUSES.has(status) || !platformAccountId) {
      account.customerAccessBlocked = false;
      account.enabled = false;
      await account.save();
      continue;
    }

    const record = currentPlatformRecord(account);
    const platformStatus = String(record?.status || "").toUpperCase();
    if (TERMINAL_PLATFORM_STATUSES.has(platformStatus)) {
      platformErrors.push({
        accountId: account.accountId,
        message: `Cannot reactivate terminal Trader account in status ${platformStatus}.`,
      });
      continue;
    }

    try {
      if (platformStatus !== "ACTIVE") {
        const connector = connectorResolver(account.platform);
        await connector.resumeAccount({
          externalRef: account.accountId,
          platformAccountId,
          reason: "ACG_FUNDED_CUSTOMER_REACTIVATED",
        });
      }
      if (record) record.status = "ACTIVE";
      account.customerAccessBlocked = false;
      account.enabled = true;
      await account.save();
    } catch (error) {
      platformErrors.push({
        accountId: account.accountId,
        message: String(error?.message || error),
      });
    }
  }

  return { platformErrors };
}
