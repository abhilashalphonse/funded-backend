import { getTradingConnector } from "./registry.js";

export async function provisionTradingAccount(account, { phase = account.currentPhase || 1, accountType = "CHALLENGE" } = {}) {
  const provider = account.platform;
  const connector = getTradingConnector(provider);
  const normalizedAccountType = String(accountType || "CHALLENGE").toUpperCase();
  const externalRef = normalizedAccountType === "FUNDED"
    ? `${account.accountId}:funded:${phase}`
    : `${account.accountId}:phase:${phase}`;
  const riskPolicy = buildRiskPolicy(account, phase, { includeProfitTarget: normalizedAccountType !== "FUNDED" });

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
      riskPolicy,
      riskTimezone: "UTC",
      metadata: {
        fundedAccountId: account.accountId,
        phase: Number(phase),
        challengeType: account.challengeType,
        accountType: normalizedAccountType,
      },
    });

    const record = {
      phase: Number(phase),
      accountType: normalizedAccountType,
      externalRef,
      platformAccountId: String(result.platformAccountId),
      accountCode: result.accountCode || null,
      login: result.login == null ? null : String(result.login),
      status: "ACTIVE",
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

export function buildRiskPolicy(account, phase = account.currentPhase || 1, { includeProfitTarget = true } = {}) {
  const balance = Number(account.initialDeposit || account.accountSize || 0);
  const phaseRule = account.rules?.phases?.find(item => Number(item.phase) === Number(phase));
  return {
    dailyLoss: { limit: percentAmount(balance, account.rules?.dailyDrawdown), reference: "DAILY_START_EQUITY" },
    maxLoss: { limit: percentAmount(balance, account.rules?.maxDrawdown), reference: "INITIAL_BALANCE" },
    ...(includeProfitTarget ? { profitTarget: percentAmount(balance, phaseRule?.profitTarget) } : {}),
    breachAction: "LIQUIDATE_AND_LOCK",
  };
}

function percentAmount(balance, percent) {
  const amount = balance * Number(percent || 0) / 100;
  return Number.isFinite(amount) ? String(amount) : "0";
}
