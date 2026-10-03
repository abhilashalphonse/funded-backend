import { getTradingConnector } from "./registry.js";

export const ACG_FUNDED_RISK_POLICY_V1_VERSION = "ACG_FUNDED_V1";
export const ACG_FUNDED_RISK_POLICY_V2_VERSION = "ACG_FUNDED_V2";

export const ACG_FUNDED_V1_EXECUTION_POLICY = Object.freeze({
  maxRiskPerTradePercent: 1,
  maxAggregateRiskPercent: 2,
  maxMarginUsagePercent: 50,
  maxSingleOrderMarginPercentOfFree: 20,
  maxSymbolMarginPercentOfPermitted: 30,
  maxOpenPositions: 10,
  maxPositionsPerSymbol: 3,
  maxPendingOrders: 10,
  maxPendingOrdersPerSymbol: 3,
});

export const ACG_FUNDED_V2_EXECUTION_POLICY = Object.freeze({
  maxRiskPerTradePercent: null,
  maxAggregateRiskPercent: null,
  maxMarginUsagePercent: null,
  maxSingleOrderMarginPercentOfFree: null,
  maxSymbolMarginPercentOfPermitted: null,
  maxOpenPositions: 10,
  maxPositionsPerSymbol: 3,
  maxPendingOrders: 10,
  maxPendingOrdersPerSymbol: 3,
});

// Compatibility aliases represent the V2 contract. Production rollout remains
// gated by resolveProvisioningRiskPolicyVersion() until staging validation passes.
export const ACG_FUNDED_RISK_POLICY_VERSION = ACG_FUNDED_RISK_POLICY_V2_VERSION;
export const ACG_FUNDED_EXECUTION_POLICY = ACG_FUNDED_V2_EXECUTION_POLICY;

export const ACG_FUNDED_TRADING_PERMISSION_DEFAULTS = Object.freeze({
  newsTrading: true,
  weekendHolding: true,
  highImpactOnly: true,
  newsRestrictionBeforeMinutes: 5,
  newsRestrictionAfterMinutes: 5,
  closeReduceAlwaysAllowed: true,
  pendingEntriesBlocked: true,
  weekendCloseBufferMinutes: 5,
  weekendBreach: false,
  carryToMaster: true,
});

export function buildTradingPermissions(account = {}) {
  const commercial = account?.commercialTerms || {};
  return {
    ...ACG_FUNDED_TRADING_PERMISSION_DEFAULTS,
    // Missing historical values stay permissive by product decision.
    newsTrading: commercial.newsTrading !== false,
    weekendHolding: commercial.weekendHolding !== false,
  };
}

export function resolveProvisioningRiskPolicyVersion(env = process.env) {
  const configured = String(env.ACG_FUNDED_RISK_POLICY_VERSION || ACG_FUNDED_RISK_POLICY_V1_VERSION).trim().toUpperCase();
  if (![ACG_FUNDED_RISK_POLICY_V1_VERSION, ACG_FUNDED_RISK_POLICY_V2_VERSION].includes(configured)) {
    const error = new Error("ACG_FUNDED_RISK_POLICY_VERSION must be ACG_FUNDED_V1 or ACG_FUNDED_V2.");
    error.code = "INVALID_ACG_FUNDED_RISK_POLICY_VERSION";
    throw error;
  }
  return configured;
}

export function executionPolicyForVersion(version) {
  const normalized = String(version || "").trim().toUpperCase();
  if (normalized === ACG_FUNDED_RISK_POLICY_V1_VERSION) return ACG_FUNDED_V1_EXECUTION_POLICY;
  if (normalized === ACG_FUNDED_RISK_POLICY_V2_VERSION) return ACG_FUNDED_V2_EXECUTION_POLICY;
  const error = new Error(`Unsupported ACG Funded risk policy version: ${version}`);
  error.code = "UNSUPPORTED_ACG_FUNDED_RISK_POLICY_VERSION";
  throw error;
}

export async function provisionTradingAccount(account, {
  phase = account.currentPhase || 1,
  accountType = "CHALLENGE",
  activate = true,
  riskPolicyVersion = resolveProvisioningRiskPolicyVersion(),
} = {}) {
  const provider = account.platform;
  const connector = getTradingConnector(provider);
  const normalizedAccountType = String(accountType || "CHALLENGE").toUpperCase();
  const externalRef = normalizedAccountType === "FUNDED"
    ? `${account.accountId}:funded:${phase}`
    : `${account.accountId}:phase:${phase}`;
  const riskPolicy = buildRiskPolicy(account, phase, {
    includeProfitTarget: normalizedAccountType !== "FUNDED",
    riskPolicyVersion,
  });
  const tradingPermissions = buildTradingPermissions(account);

  account.provisioning = { status: "PENDING", error: null, updatedAt: new Date() };
  await account.save();

  try {
    const result = await connector.provisionAccount({
      externalRef,
      ownerExternalRef: account.ownerExternalRef,
      accountType: normalizedAccountType,
      currency: "USD",
      leverage: account.leverage || 100,
      initialBalance: account.initialDeposit || account.accountSize,
      activate,
      riskPolicy,
      tradingPermissions,
      riskTimezone: "UTC",
      metadata: {
        fundedAccountId: account.accountId,
        phase: Number(phase),
        challengeType: account.challengeType,
        accountType: normalizedAccountType,
        riskPolicyVersion,
      },
    });

    const record = {
      phase: Number(phase),
      accountType: normalizedAccountType,
      externalRef,
      platformAccountId: String(result.platformAccountId),
      accountCode: result.accountCode || null,
      login: result.login == null ? null : String(result.login),
      status: String(result?.raw?.status || (activate ? "ACTIVE" : "PAUSED")).toUpperCase(),
      provisionedAt: new Date(),
    };

    const existingIndex = account.platformAccounts.findIndex(item =>
      Number(item.phase) === Number(phase)
      && String(item.accountType || "CHALLENGE").toUpperCase() === normalizedAccountType
    );
    if (existingIndex >= 0) account.platformAccounts.splice(existingIndex, 1, record);
    else account.platformAccounts.push(record);

    account.platformAccountId = record.platformAccountId;
    account.platformAccountCode = record.accountCode;
    account.platformLogin = record.login;
    if (record.login && /^\d+$/.test(record.login)) account.login = Number(record.login);
    account.provisioning = { status: "ACTIVE", error: null, updatedAt: new Date() };
    await account.save();
    return result;
  } catch (error) {
    account.provisioning = {
      status: "FAILED",
      error: String(error?.message || "Trading provider provisioning failed").slice(0, 1000),
      updatedAt: new Date(),
    };
    await account.save();
    throw error;
  }
}


export async function activateTradingAccount(account, {
  platformAccountId = account?.platformAccountId,
  reason = "ACG_FUNDED_LIFECYCLE_ACTIVATED",
} = {}) {
  const id = String(platformAccountId || "").trim();
  if (!id) throw new Error("Trading platform account is missing.");
  if (account.platform === "acg-trader") {
    const connector = getTradingConnector(account.platform);
    await connector.activateAccount({ platformAccountId: id, reason });
  }
  const record = account.platformAccounts?.find(item => String(item.platformAccountId || "") === id);
  if (record) record.status = "ACTIVE";
  return account;
}

export async function stageTradingAccount(account, {
  platformAccountId = account?.platformAccountId,
  reason = "ACG_FUNDED_LIFECYCLE_STAGED",
} = {}) {
  const id = String(platformAccountId || "").trim();
  if (!id) return account;
  if (account.platform === "acg-trader") {
    const connector = getTradingConnector(account.platform);
    await connector.stageAccount({ platformAccountId: id, reason, cancelPending: true });
  }
  const record = account.platformAccounts?.find(item => String(item.platformAccountId || "") === id);
  if (record && !["BREACHED", "CLOSED", "DISABLED"].includes(String(record.status || "").toUpperCase())) {
    record.status = "PAUSED";
  }
  return account;
}

export function buildRiskPolicy(account, phase = account.currentPhase || 1, {
  includeProfitTarget = true,
  riskPolicyVersion = resolveProvisioningRiskPolicyVersion(),
} = {}) {
  const balance = Number(account.initialDeposit || account.accountSize || 0);
  const phaseRule = account.rules?.phases?.find(item => Number(item.phase) === Number(phase));
  return {
    dailyLoss: { limit: percentAmount(balance, account.rules?.dailyDrawdown), reference: "DAILY_START_EQUITY" },
    maxLoss: { limit: percentAmount(balance, account.rules?.maxDrawdown), reference: "INITIAL_BALANCE" },
    ...(includeProfitTarget ? { profitTarget: percentAmount(balance, phaseRule?.profitTarget) } : {}),
    ...executionPolicyForVersion(riskPolicyVersion),
    breachAction: "LIQUIDATE_AND_LOCK",
  };
}

function percentAmount(balance, percent) {
  const amount = balance * Number(percent || 0) / 100;
  return Number.isFinite(amount) ? String(amount) : "0";
}
