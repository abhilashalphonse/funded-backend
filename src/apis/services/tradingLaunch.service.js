import Account from "../../accounts/account.model.js";
import { getTradingConnector } from "../../connectors/trading/registry.js";
import { recordAnalyticsEventOnce } from "./analytics.service.js";

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

export async function createCustomerTradingLaunch(customer, accountId) {
  const account = await Account.findOne({
    accountId: String(accountId),
    ...ownershipQuery(customer),
  });

  if (!account) {
    const error = new Error("Trading account not found.");
    error.status = 404;
    throw error;
  }
  if (!["ACTIVE", "PHASE_2", "FUNDED"].includes(account.status) || !account.enabled) {
    const error = new Error("This trading account is not currently available for trading.");
    error.status = 409;
    throw error;
  }
  if (account.platform !== "acg-trader") {
    const error = new Error("This account is not provisioned on ACG Trader.");
    error.status = 409;
    throw error;
  }

  const currentPhase = Number(account.currentPhase || 1);
  const currentPlatformAccount = account.status === "FUNDED"
    ? (account.platformAccounts || []).find(
        item => String(item.accountType || "").toUpperCase() === "FUNDED" && item.status === "ACTIVE"
      )
    : (account.platformAccounts || []).find(
        item =>
          Number(item.phase) === currentPhase
          && String(item.accountType || "CHALLENGE").toUpperCase() !== "FUNDED"
          && item.status === "ACTIVE"
      );

  const platformAccountIds = [];
  if (currentPlatformAccount?.platformAccountId) {
    platformAccountIds.push(String(currentPlatformAccount.platformAccountId));
  } else if (account.platformAccountId) {
    platformAccountIds.push(String(account.platformAccountId));
  }
  if (platformAccountIds.length === 0) {
    const error = new Error("The trading platform account has not finished provisioning.");
    error.status = 409;
    throw error;
  }

  const connector = getTradingConnector("acg-trader");
  const session = await connector.createTradingSession({
    ownerExternalRef: account.ownerExternalRef,
    platformAccountIds,
    metadata: { fundedAccountId: account.accountId, phase: account.currentPhase, status: account.status },
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
    },
  }, { accountId: account.accountId }).catch(() => {});

  return {
    accountId: account.accountId,
    launchUrl: launch.toString(),
    expiresAt: session.expiresAt || null,
  };
}
