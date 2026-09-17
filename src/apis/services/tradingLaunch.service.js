import Account from "../../accounts/account.model.js";
import { getTradingConnector } from "../../connectors/trading/registry.js";

function ownerRefs(customer) {
  return [customer.id, customer.email].filter(Boolean);
}

export async function createCustomerTradingLaunch(customer, accountId) {
  const account = await Account.findOne({
    accountId: String(accountId),
    ownerExternalRef: { $in: ownerRefs(customer) },
    accountMode: { $ne: "DEMO" },
  });

  if (!account) {
    const error = new Error("Trading account not found.");
    error.status = 404;
    throw error;
  }
  if (!["ACTIVE", "PHASE_2", "FUNDED_REVIEW", "FUNDED"].includes(account.status) || !account.enabled) {
    const error = new Error("This trading account is not currently available for trading.");
    error.status = 409;
    throw error;
  }
  if (account.platform !== "acg-trader") {
    const error = new Error("This account is not provisioned on ACG Trader.");
    error.status = 409;
    throw error;
  }

  const platformAccountIds = (account.platformAccounts || [])
    .filter(item => item.status === "ACTIVE")
    .map(item => String(item.platformAccountId))
    .filter(Boolean);
  if (platformAccountIds.length === 0 && account.platformAccountId) platformAccountIds.push(String(account.platformAccountId));
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

  return {
    accountId: account.accountId,
    launchUrl: launch.toString(),
    expiresAt: session.expiresAt || null,
  };
}
