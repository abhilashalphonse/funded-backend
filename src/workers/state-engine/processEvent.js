import Account from "../../accounts/account.model.js";
import { evaluateRules } from "./rules.js";
import { resolveDecision } from "./decisions.js";
import { CommandQueue } from "./commandQueue.js";
import { recordAnalyticsEventOnce } from "../../apis/services/analytics.service.js";

const SNAPSHOT_EVENT = "ACG_TRADER_ACCOUNT_SNAPSHOT";
const DEAL_EVENT = "ACG_TRADER_DEAL_CREATED";
const CONTROL_EVENT = "ACG_TRADER_ACCOUNT_CONTROLLED";
const CLOSE_DEAL_TYPES = new Set(["CLOSE", "PARTIAL_CLOSE", "REVERSE_CLOSE", "STOP_LOSS", "TAKE_PROFIT", "LIQUIDATION"]);

export async function processEvent(event, boss, { accountModel = Account } = {}) {
  const account = await accountModel.findOne({ accountId: event.aggregateId });
  if (!account) {
    // Events can legitimately outlive a Funded account after local resets,
    // deletions, or lifecycle cleanup. Retrying can never succeed and can
    // starve current projections behind stale work.
    return;
  }

  if (account.lastProcessedEventId === event.eventId) {
    if (shouldReplayPendingCommand(account, event)) {
      const commandQueue = new CommandQueue(boss);
      await commandQueue.enqueueCommand(account.commandPending, account);
    }
    return;
  }

  if (String(event.eventType || "").startsWith("ACG_TRADER_") && !isEventForCurrentPlatformAccount(account, event)) {
    account.lastProcessedEventId = event.eventId;
    await account.save();
    return;
  }

  if (event.eventType === CONTROL_EVENT) {
    if (hasControlMetrics(event.payload)) applySnapshotEvent(account, event);
    applyControlEvent(account, event);
    if (account.status === "FUNDED" && String(event.payload?.status || "").toUpperCase() === "BREACHED") {
      account.status = "BREACHED";
      account.enabled = false;
      if (!account.breach?.breachedAt) {
        const breach = buildControlBreachRecord(account, event);
        account.breach = breach;
        account.projections = account.projections || {};
        account.projections.breachedAt = breach.breachedAt;
      }
    }
    account.lastProcessedEventId = event.eventId;
    await account.save();
    return;
  }

  if (event.eventType === DEAL_EVENT) {
    applyDealEvent(account, event);
    account.lastProcessedEventId = event.eventId;
    await account.save();
    await recordAnalyticsEventOnce({
      event: "first_trade",
      sessionId: `account:${account.accountId}`,
      accountId: account.accountId,
      source: "server",
      properties: {
        ownerExternalRef: account.ownerExternalRef,
        accountMode: account.accountMode,
        challengeType: account.challengeType,
      },
    }, { accountId: account.accountId }).catch(() => {});
    return;
  }

  if (event.eventType !== SNAPSHOT_EVENT) {
    // Legacy providers still use the generic projection contract.
    if (event.metadata?.provider === "acg-trader") {
      account.lastProcessedEventId = event.eventId;
      await account.save();
      return;
    }
  }

  if (["BREACHED", "LOCKED"].includes(account.status)) {
    // A breach is terminal for challenge decisions, but ACG Trader may still
    // emit an authoritative post-liquidation valuation after LOCK_ACCOUNT.
    // Reconcile only account metrics so floating P&L/margin can settle to zero
    // without re-running rules or changing the immutable breach record.
    if (
      event.eventType === SNAPSHOT_EVENT
      && isAuthoritativeTraderSnapshot(event)
      && !isOlderThanLastAuthoritativeSnapshot(account, event)
    ) {
      applySnapshotMetrics(account, event);
      account.lastPlatformSnapshotAt = snapshotTime(event);
      const sequence = snapshotSequence(event);
      if (sequence !== null) account.lastPlatformSnapshotSequence = sequence;
    }
    account.lastProcessedEventId = event.eventId;
    await account.save();
    return;
  }

  if (account.status === "CLOSED") {
    account.lastProcessedEventId = event.eventId;
    await account.save();
    return;
  }

  if (event.eventType === SNAPSHOT_EVENT && !isAuthoritativeTraderSnapshot(event)) {
    // Non-authoritative valuations must never overwrite the Funded dashboard.
    // They may be useful operationally, but risk/account projections only
    // follow complete LIVE ACG Trader valuations.
    account.lastProcessedEventId = event.eventId;
    await account.save();
    return;
  }

  if (event.eventType === SNAPSHOT_EVENT && isOlderThanLastAuthoritativeSnapshot(account, event)) {
    account.lastProcessedEventId = event.eventId;
    await account.save();
    return;
  }

  applySnapshotEvent(account, event);
  if (event.eventType === SNAPSHOT_EVENT) {
    account.lastPlatformSnapshotAt = snapshotTime(event);
    const sequence = snapshotSequence(event);
    if (sequence !== null) account.lastPlatformSnapshotSequence = sequence;
  }

  if (account.status === "FUNDED") {
    account.lastProcessedEventId = event.eventId;
    await account.save();
    return;
  }

  const rules = evaluateRules(account);
  const decision = resolveDecision(account, rules);

  if (!decision.shouldUpdate) {
    account.lastProcessedEventId = event.eventId;
    await account.save();
    return;
  }

  account.status = decision.newStatus;
  if (decision.newStatus === "BREACHED" && !account.breach?.breachedAt) {
    const breach = buildBreachRecord(account, decision, event);
    account.breach = breach;
    account.projections = account.projections || {};
    account.projections.breachedAt = breach.breachedAt;
  }
  if (decision.command) {
    // Stop new dashboard launches immediately while the platform-side command
    // is pending. The command worker clears commandPending only after success.
    account.enabled = false;
    account.commandPending = decision.command;
  }
  account.lastProcessedEventId = event.eventId;
  await account.save();

  if (account.accountMode === "DEMO" && decision.command === "COMPLETE_TRIAL") {
    const properties = {
      ownerExternalRef: account.ownerExternalRef,
      accountSize: account.accountSize,
      challengeType: account.challengeType,
      completedPhase: account.currentPhase,
    };
    await recordAnalyticsEventOnce({
      event: "trial_passed",
      sessionId: `account:${account.accountId}`,
      accountId: account.accountId,
      source: "server",
      properties,
    }, { accountId: account.accountId }).catch(() => {});
    await recordAnalyticsEventOnce({
      event: "trial_completed",
      sessionId: `account:${account.accountId}`,
      accountId: account.accountId,
      source: "server",
      properties,
    }, { accountId: account.accountId }).catch(() => {});
  }

  if (account.accountMode === "DEMO" && decision.newStatus === "BREACHED") {
    await recordAnalyticsEventOnce({
      event: "trial_failed",
      sessionId: `account:${account.accountId}`,
      accountId: account.accountId,
      source: "server",
      properties: {
        ownerExternalRef: account.ownerExternalRef,
        accountSize: account.accountSize,
        challengeType: account.challengeType,
        breachReason: account.breach?.primaryReason || decision.primaryReason || null,
        triggeredRules: account.breach?.triggeredRules || decision.triggeredRules || [],
      },
    }, { accountId: account.accountId }).catch(() => {});
  }

  if (decision.command) {
    const commandQueue = new CommandQueue(boss);
    await commandQueue.enqueueCommand(decision.command, account);
  }
}

export function isEventForCurrentPlatformAccount(account, event) {
  const incoming = String(event?.payload?.platformAccountId || "").trim();
  const current = String(account?.platformAccountId || "").trim();
  if (!incoming || !current) return true;
  return incoming === current;
}

export function isAuthoritativeTraderSnapshot(event) {
  if (event?.eventType !== SNAPSHOT_EVENT) return true;
  const payload = event.payload || {};
  return payload.complete === true && String(payload.valuationStatus || "").toUpperCase() === "LIVE";
}

export function snapshotTime(event) {
  const value = event?.occurredAt || event?.receivedAt || event?.timestamp;
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

export function snapshotSequence(event) {
  const value = Number(event?.payload?.valuationSequence);
  return Number.isFinite(value) ? value : null;
}

export function isOlderThanLastAuthoritativeSnapshot(account, event) {
  if (!account?.lastPlatformSnapshotAt) return false;

  const incomingTime = snapshotTime(event).getTime();
  const currentTime = new Date(account.lastPlatformSnapshotAt).getTime();

  if (incomingTime < currentTime) return true;
  if (incomingTime > currentTime) return false;

  // Same-millisecond valuations can be emitted around one execution.
  // Use Trader's in-process monotonic valuation sequence only as a tie-breaker.
  // Timestamp remains primary so a Trader restart (sequence resets) is safe.
  const incomingSequence = snapshotSequence(event);
  const currentSequence = Number(account.lastPlatformSnapshotSequence);
  if (incomingSequence === null || !Number.isFinite(currentSequence)) return false;
  return incomingSequence <= currentSequence;
}

export function buildBreachRecord(account, decision, event) {
  const initialBalance = Number(account.initialDeposit || account.accountSize || 0);
  const dailyLimit = initialBalance * Number(account.rules?.dailyDrawdown || 0) / 100;
  const maxLimit = initialBalance * Number(account.rules?.maxDrawdown || 0) / 100;
  const primaryReason = decision?.primaryReason === "MAX_DRAWDOWN"
    ? "MAX_DRAWDOWN"
    : "DAILY_DRAWDOWN";
  const actualLoss = primaryReason === "MAX_DRAWDOWN"
    ? Number(account.projections?.totalLoss || 0)
    : Number(account.projections?.dailyLoss || 0);
  const limitAmount = primaryReason === "MAX_DRAWDOWN" ? maxLimit : dailyLimit;
  const breachedAt = snapshotTime(event);

  return {
    primaryReason,
    triggeredRules: Array.isArray(decision?.triggeredRules) ? [...decision.triggeredRules] : [primaryReason],
    breachedAt,
    phase: Number(account.currentPhase || 1),
    balance: finiteOrNull(account.balance),
    equity: finiteOrNull(account.equity),
    dailyStartEquity: finiteOrNull(account.dailyStartEquity),
    initialBalance: finiteOrNull(initialBalance),
    dailyLoss: finiteOrNull(account.projections?.dailyLoss),
    totalLoss: finiteOrNull(account.projections?.totalLoss),
    limitAmount: finiteOrNull(limitAmount),
    actualLoss: finiteOrNull(actualLoss),
    breachAmount: finiteOrNull(Math.max(0, actualLoss - limitAmount)),
  };
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function applySnapshotMetrics(account, event) {
  const p = event.payload || {};
  assignFinite(account, "balance", p.balance);
  assignFinite(account, "equity", p.equity);
  assignFinite(account, "margin", p.margin);
  assignFinite(account, "marginFree", p.marginFree);
  assignFinite(account, "marginLevel", p.marginLevel);
  assignFinite(account, "floatingProfit", p.floatingProfit);
}

function applySnapshotEvent(account, event) {
  const p = event.payload || {};
  const eventDate = new Date(event.occurredAt || event.receivedAt || Date.now());
  account.projections = account.projections || {};

  applySnapshotMetrics(account, event);

  const initialBalance = Number(account.initialDeposit || account.accountSize || 0);
  const balance = Number(account.balance || 0);
  const equity = Number(account.equity || 0);

  if (!Number.isFinite(account.projections.highestBalance) || account.projections.highestBalance === 0) account.projections.highestBalance = balance;
  account.projections.highestBalance = Math.max(account.projections.highestBalance, balance);
  if (!Number.isFinite(account.projections.highestEquity) || account.projections.highestEquity === 0) account.projections.highestEquity = equity;
  account.projections.highestEquity = Math.max(account.projections.highestEquity, equity);
  account.projections.profit = balance - initialBalance;

  const riskDayKey = String(p.riskDayKey || eventDate.toISOString().split("T")[0]);
  const authoritativeDailyStartEquity = Number(p.dailyStartEquity);

  if (account.riskDayKey !== riskDayKey) {
    account.riskDayKey = riskDayKey;
    account.dailyResetAt = eventDate;
  }

  if (Number.isFinite(authoritativeDailyStartEquity) && authoritativeDailyStartEquity > 0) {
    account.dailyStartEquity = authoritativeDailyStartEquity;
  } else if (!Number.isFinite(Number(account.dailyStartEquity)) || Number(account.dailyStartEquity) === 0) {
    account.dailyStartEquity = initialBalance;
  }

  account.projections.dailyLoss = Math.max(0, Number(account.dailyStartEquity) - equity);
  account.projections.totalLoss = Math.max(0, initialBalance - equity);
}

function applyDealEvent(account, event) {
  const p = event.payload || {};
  const type = String(p.type || "").toUpperCase();
  const executedAt = new Date(p.executedAt || event.occurredAt || event.receivedAt || Date.now());
  const tradingDay = Number.isNaN(executedAt.getTime()) ? null : executedAt.toISOString().slice(0, 10);

  if (tradingDay && account.lastTradingDay !== tradingDay) {
    account.lastTradingDay = tradingDay;
    account.lastActiveDay = tradingDay;
    account.projections = account.projections || {};
    account.projections.tradingDays = Number(account.projections.tradingDays || 0) + 1;
  }

  if (!CLOSE_DEAL_TYPES.has(type)) return;
  account.totalTrades = Number(account.totalTrades || 0) + 1;
  const realized = Number(p.realizedPnl || 0) - Number(p.commission || 0);
  if (realized > 0) account.winningTrades = Number(account.winningTrades || 0) + 1;
  else if (realized < 0) account.losingTrades = Number(account.losingTrades || 0) + 1;
}

export function buildControlBreachRecord(account, event) {
  const reason = String(event?.payload?.reason || "").toUpperCase();
  const primaryReason = reason.includes("MAX") ? "MAX_DRAWDOWN" : "DAILY_DRAWDOWN";
  const occurredAt = event?.payload?.breachedAt || event?.occurredAt || event?.timestamp || new Date();
  return buildBreachRecord(
    account,
    { primaryReason, triggeredRules: [primaryReason] },
    { ...event, occurredAt },
  );
}

function hasControlMetrics(payload = {}) {
  return ["balance", "equity", "floatingProfit", "margin", "marginFree", "dailyStartEquity"]
    .some(key => payload?.[key] !== undefined && payload?.[key] !== null);
}

function applyControlEvent(account, event) {
  const platformAccountId = String(event.payload?.platformAccountId || "");
  const status = String(event.payload?.status || "");
  if (!platformAccountId || !status) return;
  const record = account.platformAccounts?.find(item => String(item.platformAccountId) === platformAccountId);
  if (record) record.status = status;
}

function assignFinite(target, field, value) {
  if (value === undefined || value === null) return;
  const number = Number(value);
  if (Number.isFinite(number)) target[field] = number;
}


export function shouldReplayPendingCommand(account, event) {
  return Boolean(account?.commandPending && account?.lastProcessedEventId === event?.eventId);
}
