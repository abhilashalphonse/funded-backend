import { randomUUID } from "node:crypto";
import Account from "../../accounts/account.model.js";
import simulatorEngine from "../../simulator/engine.js";
import { configuredTradingProvider, getTradingConnector } from "../../connectors/trading/registry.js";
import { activateTradingAccount, provisionTradingAccount, stageTradingAccount } from "../../connectors/trading/account-provisioning.js";
import { ensureTradingCredential } from "../../trading-credentials/trading-credential.service.js";
import { recordAnalyticsEventOnce } from "./analytics.service.js";
import {
  ACTIVE_DEMO_STATUSES,
  activeDemoAccountQuery,
  customerFacingTrialProvisioningError,
  freeTrialExpiry,
  trialMetadata,
  trialResultForStatus,
} from "./freeTrialPolicy.js";

function ownerQuery(customer) {
  const customerIds = [...new Set([customer.customerId, ...(customer.customerIds || [])].filter(Boolean))];
  const legacyRefs = [...new Set([customer.id, customer.email, ...customerIds].filter(Boolean))];
  return {
    $or: [
      { customerId: { $in: customerIds } },
      { ownerExternalRef: { $in: legacyRefs } },
    ],
  };
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
    commercialTerms: account.commercialTerms,
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
    breach: account.breach || null,
    trial: account.accountMode === "DEMO"
      ? trialMetadata(account, account.trial?.result || trialResultForStatus(account.status), account.trial?.completedAt)
      : undefined,
    totalTrades: account.totalTrades,
    winningTrades: account.winningTrades,
    losingTrades: account.losingTrades,
    lastPlatformSnapshotAt: account.lastPlatformSnapshotAt,
    lastPlatformSnapshotSequence: account.lastPlatformSnapshotSequence,
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
      customerId: customer.customerId,
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

export async function ensureDemoAccount(customer, input = {}) {
  const active = await Account.findOne(activeDemoAccountQuery(ownerQuery(customer))).sort({ createdAt: -1 });

  if (active) {
    const error = new Error("You already have an active free trial. Finish or close it before starting another.");
    error.status = 409;
    throw error;
  }

  const definition = input?.challengeDefinition || {};
  const rulesInput = definition.rules || {};
  const step = definition.step === "1step" ? "1step" : "2step";
  const accountSize = Number(definition.accountSize || 100000);

  if (!Number.isFinite(accountSize) || accountSize <= 0) {
    const error = new Error("A valid trial account size is required.");
    error.status = 400;
    throw error;
  }

  const phases = step === "2step"
    ? [
        { phase: 1, profitTarget: Number(rulesInput.phase1ProfitTarget ?? 8) },
        { phase: 2, profitTarget: Number(rulesInput.phase2ProfitTarget ?? 5) },
      ]
    : [{ phase: 1, profitTarget: Number(rulesInput.profitTarget ?? 10) }];

  const accountId = `TRIAL-${randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`;
  const platform = configuredTradingProvider();
  const startedAt = new Date();

  let account;
  try {
    account = await Account.create({
    accountId,
    ownerExternalRef: customer.customerId,
    customerId: customer.customerId,
    activeTrialKey: customer.customerId,
    accountMode: "DEMO",
    trial: {
      startedAt,
      expiresAt: freeTrialExpiry(startedAt),
      completedAt: null,
      cancelledAt: null,
      result: null,
    },
    challengeType: step === "2step" ? "TWO_STEP" : "ONE_STEP",
    accountSize,
    initialDeposit: accountSize,
    currentPhase: 1,
    rules: {
      dailyDrawdown: Number(rulesInput.dailyLoss ?? 5),
      maxDrawdown: Number(rulesInput.maxLoss ?? 10),
      minimumTradingDays: Number(rulesInput.minTradingDays ?? 0),
      phases,
    },
    leverage: 100,
    platform,
    status: "NEW",
    enabled: false,
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
  } catch (error) {
    if (error?.code === 11000) {
      const conflict = new Error("You already have an active free trial. Finish or close it before starting another.");
      conflict.status = 409;
      conflict.code = "ACTIVE_TRIAL_EXISTS";
      throw conflict;
    }
    throw error;
  }

  try {
    const staged = platform === "acg-trader";
    await provisionTradingAccount(account, { phase: 1, accountType: "DEMO", activate: !staged });

    // Commit the lifecycle identity before making the remote account tradable.
    account.status = "ACTIVE";
    account.enabled = !staged;
    await account.save();

    if (staged) {
      await activateTradingAccount(account, {
        reason: "ACG_FUNDED_TRIAL_LIFECYCLE_COMMITTED",
      });
      const activated = await Account.findOneAndUpdate(
        {
          _id: account._id,
          status: "ACTIVE",
          activeTrialKey: customer.customerId,
          customerAccessBlocked: { $ne: true },
        },
        {
          $set: {
            enabled: true,
            "platformAccounts.$[target].status": "ACTIVE",
          },
        },
        {
          new: true,
          arrayFilters: [{ "target.platformAccountId": account.platformAccountId }],
        },
      );
      if (!activated) {
        await stageTradingAccount(account, {
          reason: "ACG_FUNDED_TRIAL_ACTIVATION_SUPERSEDED",
        }).catch(() => {});
        const error = new Error("Trial activation was superseded by a newer lifecycle state.");
        error.code = "TRIAL_ACTIVATION_SUPERSEDED";
        throw error;
      }
      account = activated;
    }

    await ensureTradingCredential(account, {
      email: customer.email,
      queueEmail: true,
      platformAccountId: account.platformAccountId,
    }).catch(() => {});

    return serializeCustomerAccount(account);
  } catch (error) {
    await stageTradingAccount(account, {
      reason: "ACG_FUNDED_TRIAL_ACTIVATION_FAILED",
    }).catch(() => {});
    await Account.updateOne(
      {
        _id: account._id,
        status: { $in: ["NEW", "ACTIVE"] },
        activeTrialKey: customer.customerId,
      },
      {
        $set: {
          status: "CLOSED",
          enabled: false,
          activeTrialKey: null,
        },
      },
    ).catch(() => {});
    throw customerFacingTrialProvisioningError(error);
  }
}

export async function cancelDemoAccount(customer, accountId) {
  const account = await Account.findOne({
    accountId: String(accountId),
    ...ownerQuery(customer),
    accountMode: "DEMO",
  });

  if (!account) {
    const error = new Error("Demo account not found.");
    error.status = 404;
    error.code = "TRIAL_NOT_FOUND";
    throw error;
  }

  const status = String(account.status || "").toUpperCase();
  if (!ACTIVE_DEMO_STATUSES.includes(status)) {
    const error = new Error("Only an active free trial can be cancelled.");
    error.status = 409;
    error.code = "TRIAL_NOT_ACTIVE";
    throw error;
  }

  const now = new Date();
  const trial = {
    ...trialMetadata(account, "CANCELLED", now),
    cancelledAt: now,
  };
  const cancelled = await Account.findOneAndUpdate(
    {
      _id: account._id,
      accountMode: "DEMO",
      status: { $in: [...ACTIVE_DEMO_STATUSES] },
    },
    {
      $set: {
        status: "CLOSED",
        enabled: false,
        activeTrialKey: null,
        commandPending: null,
        trial,
      },
    },
    { new: true },
  );

  if (!cancelled) {
    const error = new Error("The trial changed state while it was being cancelled.");
    error.status = 409;
    error.code = "TRIAL_STATE_CHANGED";
    throw error;
  }

  const connector = getTradingConnector(cancelled.platform);
  const closeErrors = [];
  for (const record of cancelled.platformAccounts || []) {
    if (!["ACTIVE", "PAUSED"].includes(String(record.status || "").toUpperCase())) continue;
    try {
      await connector.closeAccount({
        externalRef: record.externalRef || cancelled.accountId,
        platformAccountId: record.platformAccountId,
        reason: "ACG_FUNDED_TRIAL_CANCELLED",
        liquidate: true,
      });
      record.status = "CLOSED";
    } catch (error) {
      closeErrors.push(error);
    }
  }
  await cancelled.save().catch(() => {});

  await recordAnalyticsEventOnce({
    event: "trial_cancelled",
    sessionId: `account:${cancelled.accountId}`,
    customer,
    accountId: cancelled.accountId,
    source: "server",
    properties: {
      customerId: customer.customerId,
      accountSize: cancelled.accountSize,
      challengeType: cancelled.challengeType,
    },
  }, { accountId: cancelled.accountId }).catch(() => {});

  if (closeErrors.length) {
    const error = new Error("Trial cancellation was recorded, but trading shutdown is still being retried.");
    error.status = 503;
    error.code = "TRIAL_REMOTE_CLOSE_PENDING";
    error.retryable = true;
    throw error;
  }

  return serializeCustomerAccount(cancelled);
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
