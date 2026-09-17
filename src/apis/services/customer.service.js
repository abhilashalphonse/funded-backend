import { randomUUID } from "node:crypto";
import Account from "../../accounts/account.model.js";
import simulatorEngine from "../../simulator/engine.js";

function ownerQuery(customer) {
  const values = [customer.id, customer.email].filter(Boolean);
  return { ownerExternalRef: { $in: values } };
}

function demoPositions(account) {
  return Array.isArray(account.demoTrading?.positions) ? account.demoTrading.positions : [];
}

function demoHistory(account) {
  return Array.isArray(account.demoTrading?.history) ? account.demoTrading.history : [];
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
    demoTrading: account.accountMode === "DEMO" ? {
      positions: demoPositions(account),
      history: demoHistory(account).slice(-100).reverse(),
    } : undefined,
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
    demoTrading: { positions: [], history: [] },
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

async function ownedDemoAccount(customer, accountId) {
  const account = await Account.findOne({ accountId: String(accountId), ...ownerQuery(customer), accountMode: "DEMO" });
  if (!account) {
    const error = new Error("Demo account not found.");
    error.status = 404;
    throw error;
  }
  if (!account.enabled || account.status !== "ACTIVE") {
    const error = new Error("Demo account is not available for trading.");
    error.status = 409;
    throw error;
  }
  return account;
}

function normalizeOrder({ symbol, side, quantity, price }) {
  const normalizedSymbol = String(symbol || "").trim().toUpperCase();
  const normalizedSide = String(side || "").trim().toUpperCase();
  const normalizedQuantity = Number(quantity);
  const normalizedPrice = Number(price);

  if (!/^[A-Z0-9]{3,16}$/.test(normalizedSymbol)) throw new Error("A valid symbol is required.");
  if (!["BUY", "SELL"].includes(normalizedSide)) throw new Error("Side must be BUY or SELL.");
  if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) throw new Error("Quantity must be greater than zero.");
  if (!Number.isFinite(normalizedPrice) || normalizedPrice <= 0) throw new Error("A valid market price is required.");

  return { symbol: normalizedSymbol, side: normalizedSide, quantity: normalizedQuantity, price: normalizedPrice };
}

export async function placeDemoOrder(customer, accountId, input) {
  const account = await ownedDemoAccount(customer, accountId);
  const order = normalizeOrder(input);
  const notional = order.quantity * order.price;
  const maxNotional = Number(account.balance || 0) * 5;
  if (notional > maxNotional) {
    const error = new Error("Demo order exceeds the maximum simulated exposure.");
    error.status = 400;
    throw error;
  }

  account.demoTrading = account.demoTrading || { positions: [], history: [] };
  account.demoTrading.positions.push({
    positionId: randomUUID(),
    symbol: order.symbol,
    side: order.side,
    quantity: order.quantity,
    entryPrice: order.price,
    openedAt: new Date(),
  });
  account.margin = Number(account.margin || 0) + notional / Number(account.leverage || 100);
  account.marginFree = Math.max(0, Number(account.balance || 0) - account.margin);
  await account.save();
  return serializeCustomerAccount(account);
}

export async function closeDemoPosition(customer, accountId, positionId, input) {
  const account = await ownedDemoAccount(customer, accountId);
  const exitPrice = Number(input?.price);
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) throw new Error("A valid market price is required.");

  const positions = demoPositions(account);
  const index = positions.findIndex(position => String(position.positionId) === String(positionId));
  if (index < 0) {
    const error = new Error("Demo position not found.");
    error.status = 404;
    throw error;
  }

  const position = positions[index];
  const direction = position.side === "BUY" ? 1 : -1;
  const pnl = (exitPrice - Number(position.entryPrice)) * Number(position.quantity) * direction;
  const usedMargin = Number(position.entryPrice) * Number(position.quantity) / Number(account.leverage || 100);

  account.demoTrading.positions.splice(index, 1);
  account.demoTrading.history.push({
    tradeId: randomUUID(),
    symbol: position.symbol,
    side: position.side,
    quantity: position.quantity,
    entryPrice: position.entryPrice,
    exitPrice,
    pnl,
    openedAt: position.openedAt,
    closedAt: new Date(),
  });

  account.balance = Number(account.balance || 0) + pnl;
  account.equity = account.balance;
  account.margin = Math.max(0, Number(account.margin || 0) - usedMargin);
  account.marginFree = Math.max(0, account.balance - account.margin);
  account.totalTrades = Number(account.totalTrades || 0) + 1;
  if (pnl > 0) account.winningTrades = Number(account.winningTrades || 0) + 1;
  else if (pnl < 0) account.losingTrades = Number(account.losingTrades || 0) + 1;
  account.projections = account.projections || {};
  account.projections.profit = account.balance - Number(account.initialDeposit || account.accountSize || 0);
  account.projections.highestBalance = Math.max(Number(account.projections.highestBalance || 0), account.balance);
  account.projections.totalLoss = Math.max(0, Number(account.initialDeposit || account.accountSize || 0) - account.balance);
  await account.save();
  return serializeCustomerAccount(account);
}
