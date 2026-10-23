import { randomUUID } from "node:crypto";
import { validateChallengeConfiguration } from "../../pricing/pricingEngine.js";
import { STEP_TYPES } from "../../pricing/challengeRules.js";
import Account from "../../accounts/account.model.js";
import simulatorEngine from "../../simulator/engine.js";
import { configuredTradingProvider, getTradingConnector } from "../../connectors/trading/registry.js";
import { activateTradingAccount, provisionTradingAccount, stageTradingAccount } from "../../connectors/trading/account-provisioning.js";
import { ensureTradingCredential } from "../../trading-credentials/trading-credential.service.js";
import { recordAnalyticsEventOnce } from "./analytics.service.js";
import { assertCustomerTradingAccessAllowed } from "./customerTradingAccess.service.js";
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
      ? trialMetadata(account, account.trial?.result || trialResultForStatus(account.status, account.commandPending), account.trial?.completedAt)
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

export async function getCustomerTradingHistory(
  customer,
  accountId,
  query = {},
  {
    accountModel = Account,
    connectorResolver = getTradingConnector,
  } = {},
) {
  const account = await accountModel.findOne({
    accountId: String(accountId || "").trim(),
    ...ownerQuery(customer),
  });

  if (!account) {
    const error = new Error("Trading account not found.");
    error.status = 404;
    error.code = "TRADING_ACCOUNT_NOT_FOUND";
    throw error;
  }

  if (String(account.platform || "").toLowerCase() !== "acg-trader" || !account.platformAccountId) {
    const error = new Error("Trading history is unavailable for this account.");
    error.status = 409;
    error.code = "TRADING_HISTORY_UNAVAILABLE";
    throw error;
  }

  const normalized = normalizeTradingHistoryQuery(query);
  const connector = connectorResolver(account.platform);
  if (typeof connector?.adminTrades !== "function") {
    const error = new Error("Trading history is unavailable for this account.");
    error.status = 409;
    error.code = "TRADING_HISTORY_UNAVAILABLE";
    throw error;
  }

  const result = await connector.adminTrades({
    accountId: String(account.platformAccountId),
    ...normalized,
  });

  return {
    accountId: account.accountId,
    timezone: "UTC",
    items: Array.isArray(result?.items) ? result.items.map(serializeCustomerTrade) : [],
    page: {
      limit: Number(result?.page?.limit || normalized.limit),
      hasMore: Boolean(result?.page?.hasMore),
      nextCursor: result?.page?.nextCursor || null,
    },
  };
}

function serializeCustomerTrade(item = {}) {
  return {
    dealId: item.dealId || null,
    positionId: item.positionId || null,
    symbol: item.symbol || null,
    side: item.side || null,
    type: item.type || null,
    volume: item.volume ?? null,
    price: item.price ?? null,
    commission: item.commission ?? "0",
    swap: item.swap ?? "0",
    realizedPnl: item.realizedPnl ?? "0",
    executedAt: item.executedAt || null,
  };
}

function normalizeTradingHistoryQuery(query = {}) {
  const normalized = {
    limit: Math.max(1, Math.min(200, Number.parseInt(query.limit, 10) || 200)),
  };

  const cursor = String(query.cursor || "").trim();
  if (cursor) {
    if (!/^[0-9a-fA-F]{24}$/.test(cursor)) {
      const error = new Error("Invalid trading-history cursor.");
      error.status = 400;
      error.code = "INVALID_TRADING_HISTORY_QUERY";
      throw error;
    }
    normalized.cursor = cursor;
  }

  const symbol = String(query.symbol || "").trim().toUpperCase();
  if (symbol) {
    if (!/^[A-Z0-9._:/-]{1,32}$/.test(symbol)) {
      const error = new Error("Invalid trading-history symbol.");
      error.status = 400;
      error.code = "INVALID_TRADING_HISTORY_QUERY";
      throw error;
    }
    normalized.symbol = symbol;
  }

  const side = String(query.side || "").trim().toUpperCase();
  if (side) {
    if (!["BUY", "SELL"].includes(side)) {
      const error = new Error("Invalid trading-history side.");
      error.status = 400;
      error.code = "INVALID_TRADING_HISTORY_QUERY";
      throw error;
    }
    normalized.side = side;
  }

  const type = String(query.type || "").trim().toUpperCase();
  if (type) {
    if (!/^[A-Z_]{1,32}$/.test(type)) {
      const error = new Error("Invalid trading-history type.");
      error.status = 400;
      error.code = "INVALID_TRADING_HISTORY_QUERY";
      throw error;
    }
    normalized.type = type;
  }

  const from = normalizeHistoryTimestamp(query.from, "from");
  const to = normalizeHistoryTimestamp(query.to, "to");
  if (from) normalized.from = from;
  if (to) normalized.to = to;

  if (from && to && new Date(from).getTime() > new Date(to).getTime()) {
    const error = new Error("Trading-history 'from' must be before 'to'.");
    error.status = 400;
    error.code = "INVALID_TRADING_HISTORY_QUERY";
    throw error;
  }

  return normalized;
}

function normalizeHistoryTimestamp(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    const error = new Error(`Invalid trading-history ${field} timestamp.`);
    error.status = 400;
    error.code = "INVALID_TRADING_HISTORY_QUERY";
    throw error;
  }
  return date.toISOString();
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

// Trial defaults are intentional, but any explicitly supplied values must pass
// the same authoritative bounds as new paid challenges.
export function normalizeTrialChallenge(definition = {}) {
  if (definition == null || typeof definition !== "object" || Array.isArray(definition)) {
    const error = new Error("A valid trial challenge configuration is required.");
    error.status = 400;
    error.code = "INVALID_TRIAL_CHALLENGE_CONFIGURATION";
    throw error;
  }
  const step = definition.step ?? STEP_TYPES.TWO_STEP;
  const defaults = step === STEP_TYPES.ONE_STEP
    ? { profitTarget: 10, dailyLoss: 3, maxLoss: 6, minTradingDays: 3 }
    : { phase1ProfitTarget: 8, phase2ProfitTarget: 6, dailyLoss: 5, maxLoss: 10, minTradingDays: 3 };
  const inputRules = definition.rules ?? {};
  const accountSize = definition.accountSize ?? 100000;
  const rules = inputRules && typeof inputRules === "object" && !Array.isArray(inputRules)
    ? { ...defaults, ...inputRules }
    : inputRules;
  const validation = validateChallengeConfiguration({
    step, accountSize, rules,
    commercial: { profitSplit: 80, payoutFrequency: "Biweekly", newsTrading: false, weekendHolding: false },
  });
  if (!validation.valid) {
    const error = new Error("Invalid trial challenge configuration.");
    error.status = 400;
    error.code = "INVALID_TRIAL_CHALLENGE_CONFIGURATION";
    error.details = validation.errors;
    throw error;
  }
  return { step, accountSize, rules };
}

export async function ensureDemoAccount(customer, input = {}, { queueCredentialEmail = true } = {}) {
  const active = await Account.findOne(activeDemoAccountQuery(ownerQuery(customer))).sort({ createdAt: -1 });

  if (active) {
    const error = new Error("You already have an active free trial. Finish or close it before starting another.");
    error.status = 409;
    throw error;
  }

  const { step, accountSize, rules: rulesInput } = normalizeTrialChallenge(input?.challengeDefinition);

  const phases = step === STEP_TYPES.TWO_STEP
    ? [
        { phase: 1, profitTarget: rulesInput.phase1ProfitTarget },
        { phase: 2, profitTarget: rulesInput.phase2ProfitTarget },
      ]
    : [{ phase: 1, profitTarget: rulesInput.profitTarget }];

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
      dailyDrawdown: rulesInput.dailyLoss,
      maxDrawdown: rulesInput.maxLoss,
      minimumTradingDays: rulesInput.minTradingDays,
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
      const accessGuard = {
        code: "CUSTOMER_BLOCKED_DURING_TRIAL_ACTIVATION",
        message: "Customer was blocked while Trial activation was in progress.",
      };
      await assertCustomerTradingAccessAllowed(account, accessGuard);
      await activateTradingAccount(account, {
        reason: "ACG_FUNDED_TRIAL_LIFECYCLE_COMMITTED",
      });
      await assertCustomerTradingAccessAllowed(account, accessGuard);

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
        const latest = await Account.findById(account._id).select("customerId customerAccessBlocked").lean();
        await assertCustomerTradingAccessAllowed(latest || account, accessGuard);
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
      queueEmail: queueCredentialEmail,
      platformAccountId: account.platformAccountId,
    }).catch(() => {});

    return serializeCustomerAccount(account);
  } catch (error) {
    await stageTradingAccount(account, {
      reason: "ACG_FUNDED_TRIAL_ACTIVATION_FAILED",
    }).catch(() => {});

    if (error?.code === "CUSTOMER_BLOCKED_DURING_TRIAL_ACTIVATION") {
      await Account.updateOne(
        { _id: account._id },
        { $set: { enabled: false, customerAccessBlocked: true } },
      ).catch(() => {});
      throw customerFacingTrialProvisioningError(error);
    }

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

export async function cancelDemoAccount(customer, accountId, {
  accountModel = Account,
  connectorResolver = getTradingConnector,
  analyticsRecorder = recordAnalyticsEventOnce,
  now = () => new Date(),
} = {}) {
  const account = await accountModel.findOne({
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

  const cancelledAt = now();
  const trial = {
    ...trialMetadata(account, "CANCELLED", cancelledAt),
    cancelledAt,
  };
  const cancelled = await accountModel.findOneAndUpdate(
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

  const connector = connectorResolver(cancelled.platform);
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

  await analyticsRecorder({
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
