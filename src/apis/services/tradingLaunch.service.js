import Account from "../../accounts/account.model.js";
import { getTradingConnector } from "../../connectors/trading/registry.js";
import { recordAnalyticsEventOnce } from "./analytics.service.js";

const TRADABLE_STATUSES = new Set(["ACTIVE", "PHASE_2", "FUNDED"]);

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

export function currentPlatformAccount(account) {
  if (!account) return null;
  const currentPhase = Number(account.currentPhase || 1);
  if (String(account.status || "").toUpperCase() === "FUNDED") {
    return (account.platformAccounts || []).find(item =>
      String(item.accountType || "").toUpperCase() === "FUNDED"
      && String(item.status || "").toUpperCase() === "ACTIVE"
    ) || null;
  }
  return (account.platformAccounts || []).find(item =>
    Number(item.phase) === currentPhase
    && String(item.accountType || "CHALLENGE").toUpperCase() !== "FUNDED"
    && String(item.status || "").toUpperCase() === "ACTIVE"
  ) || null;
}

function platformAccountIdFor(account) {
  const current = currentPlatformAccount(account);
  return String(current?.platformAccountId || account?.platformAccountId || "").trim() || null;
}

function launchableAccount(account) {
  return Boolean(
    account
    && account.platform === "acg-trader"
    && account.enabled
    && TRADABLE_STATUSES.has(String(account.status || "").toUpperCase())
    && platformAccountIdFor(account)
  );
}

export async function createCustomerTradingLaunch(customer, accountId) {
  const ownership = ownershipQuery(customer);
  const account = await Account.findOne({
    accountId: String(accountId),
    ...ownership,
  });

  if (!account) {
    const error = new Error("Trading account not found.");
    error.status = 404;
    throw error;
  }
  if (!TRADABLE_STATUSES.has(String(account.status || "").toUpperCase()) || !account.enabled) {
    const error = new Error("This trading account is not currently available for trading.");
    error.status = 409;
    throw error;
  }
  if (account.platform !== "acg-trader") {
    const error = new Error("This account is not provisioned on ACG Trader.");
    error.status = 409;
    throw error;
  }

  const selectedAccountId = platformAccountIdFor(account);
  if (!selectedAccountId) {
    const error = new Error("The trading platform account has not finished provisioning.");
    error.status = 409;
    throw error;
  }

  const ownedAccounts = await Account.find({
    ...ownership,
    platform: "acg-trader",
  }).lean();

  const platformAccountIds = [...new Set(
    ownedAccounts
      .filter(launchableAccount)
      .map(platformAccountIdFor)
      .filter(Boolean)
      .concat(selectedAccountId)
  )];

  const ownerExternalRefs = [...new Set(
    ownedAccounts
      .map(item => String(item.ownerExternalRef || "").trim())
      .filter(Boolean)
      .concat(String(account.ownerExternalRef || account.customerId || customer.customerId || "").trim())
      .filter(Boolean)
  )];

  const ownerExternalRef = String(
    account.ownerExternalRef
    || account.customerId
    || customer.customerId
    || ownerExternalRefs[0]
    || ""
  ).trim();
  if (!ownerExternalRef) {
    const error = new Error("The trading account is missing its owner identity.");
    error.status = 409;
    throw error;
  }

  const connector = getTradingConnector("acg-trader");
  const session = await connector.createTradingSession({
    ownerExternalRef,
    ownerExternalRefs,
    platformAccountIds,
    selectedAccountId,
    metadata: {
      fundedAccountId: account.accountId,
      phase: account.currentPhase,
      status: account.status,
      accountCount: platformAccountIds.length,
    },
  });

  if (!session.ticket || !session.launchUrl) throw new Error("ACG Trader did not return a valid launch session.");
  const launch = new URL(session.launchUrl);
  launch.searchParams.set("ticket", session.ticket);

  await recordAnalyticsEventOnce({
    event: "trader_session_ready",
    sessionId: `account:${account.accountId}`,
    customer,
    accountId: account.accountId,
    source: "server",
    properties: {
      platform: "acg-trader",
      accountMode: account.accountMode,
      challengeType: account.challengeType,
      phase: account.currentPhase,
      grantedAccounts: platformAccountIds.length,
    },
  }, { accountId: account.accountId }).catch(() => {});

  return {
    accountId: account.accountId,
    selectedPlatformAccountId: session.selectedAccountId || selectedAccountId,
    grantedAccounts: platformAccountIds.length,
    launchUrl: launch.toString(),
    expiresAt: session.expiresAt || null,
  };
}
