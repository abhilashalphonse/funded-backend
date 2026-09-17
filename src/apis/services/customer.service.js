import Account from "../../accounts/account.model.js";
import simulatorEngine from "../../simulator/engine.js";

function ownerQuery(customer) {
  const values = [customer.id, customer.email].filter(Boolean);
  return { ownerExternalRef: { $in: values } };
}

export function serializeCustomerAccount(account) {
  return {
    id: String(account._id),
    accountId: account.accountId,
    accountMode: account.accountMode || "CHALLENGE",
    challengeType: account.challengeType,
    accountSize: account.accountSize,
    currentPhase: account.currentPhase,
    status: account.status,
    enabled: account.enabled,
    platform: account.platform,
    provisioning: account.provisioning,
    rules: account.rules,
    balance: account.balance,
    equity: account.equity,
    margin: account.margin,
    marginFree: account.marginFree,
    marginLevel: account.marginLevel,
    floatingProfit: account.floatingProfit,
    projections: account.projections,
    totalTrades: account.totalTrades,
    winningTrades: account.winningTrades,
    losingTrades: account.losingTrades,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export async function listCustomerAccounts(customer) {
  const accounts = await Account.find(ownerQuery(customer)).sort({ createdAt: -1 });
  return accounts.map(serializeCustomerAccount);
}

export async function getCustomerWorkspace(customer) {
  const accounts = await listCustomerAccounts(customer);
  const challenges = accounts.filter(account => account.accountMode !== "DEMO");
  const demos = accounts.filter(account => account.accountMode === "DEMO");
  const activeChallenge = challenges.find(account => ["NEW", "ACTIVE", "PHASE_2", "FUNDED_REVIEW", "FUNDED"].includes(account.status)) || null;

  return {
    customer: {
      id: customer.id,
      email: customer.email,
      metadata: customer.metadata || {},
    },
    hasActiveChallenge: Boolean(activeChallenge),
    activeChallenge,
    accounts,
    challenges,
    demos,
  };
}

export async function ensureDemoAccount(customer) {
  let account = await Account.findOne({ ...ownerQuery(customer), accountMode: "DEMO" }).sort({ createdAt: -1 });
  if (account) return serializeCustomerAccount(account);

  const suffix = customer.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 14).toUpperCase();
  const accountId = `DEMO-${suffix || Date.now()}`;
  const accountSize = 100000;
  const simulated = await simulatorEngine.provisionAccount({ accountId, balance: accountSize, leverage: 100 });

  account = await Account.create({
    accountId,
    ownerExternalRef: customer.id,
    accountMode: "DEMO",
    challengeType: "DEMO",
    accountSize,
    initialDeposit: accountSize,
    currentPhase: 0,
    rules: {
      dailyDrawdown: 5,
      maxDrawdown: 10,
      minimumTradingDays: 0,
      phases: [],
    },
    leverage: 100,
    platform: "simulator",
    platformAccountId: String(simulated.login),
    platformAccountCode: String(simulated.login),
    platformLogin: String(simulated.login),
    platformAccounts: [{
      phase: 0,
      externalRef: accountId,
      platformAccountId: String(simulated.login),
      accountCode: String(simulated.login),
      login: String(simulated.login),
      status: "ACTIVE",
    }],
    provisioning: { status: "ACTIVE", error: null, updatedAt: new Date() },
    status: "ACTIVE",
    enabled: true,
    balance: accountSize,
    equity: accountSize,
    dailyStartEquity: accountSize,
    marginFree: accountSize,
    projections: {
      highestBalance: accountSize,
      highestEquity: accountSize,
      profit: 0,
      dailyLoss: 0,
      totalLoss: 0,
      dailyStartBalance: accountSize,
      tradingDays: 0,
    },
  });

  return serializeCustomerAccount(account);
}
