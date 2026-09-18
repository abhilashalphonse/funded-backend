import Account from "../../accounts/account.model.js";
import { evaluateRules } from "./rules.js";
import { resolveDecision } from "./decisions.js";
import { CommandQueue } from "./commandQueue.js";

const SNAPSHOT_EVENT = "ACG_TRADER_ACCOUNT_SNAPSHOT";
const DEAL_EVENT = "ACG_TRADER_DEAL_CREATED";
const CONTROL_EVENT = "ACG_TRADER_ACCOUNT_CONTROLLED";
const CLOSE_DEAL_TYPES = new Set(["CLOSE", "PARTIAL_CLOSE", "REVERSE_CLOSE", "STOP_LOSS", "TAKE_PROFIT", "LIQUIDATION"]);

export async function processEvent(event, boss) {
  const account = await Account.findOne({ accountId: event.aggregateId });
  if (!account) throw new Error(`Account ${event.aggregateId} not found`);

  if (account.lastProcessedEventId === event.eventId) {
    if (shouldReplayPendingCommand(account, event)) {
      const commandQueue = new CommandQueue(boss);
      await commandQueue.enqueueCommand(account.commandPending, account);
    }
    return;
  }

  if (event.eventType === CONTROL_EVENT) {
    applyControlEvent(account, event);
    account.lastProcessedEventId = event.eventId;
    await account.save();
    return;
  }

  if (event.eventType === DEAL_EVENT) {
    applyDealEvent(account, event);
    account.lastProcessedEventId = event.eventId;
    await account.save();
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

  if (["BREACHED", "CLOSED", "FUNDED"].includes(account.status)) {
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
  const rules = evaluateRules(account);
  const decision = resolveDecision(account, rules);

  if (!decision.shouldUpdate) {
    account.lastProcessedEventId = event.eventId;
    await account.save();
    return;
  }

  account.status = decision.newStatus;
  if (decision.command) {
    // Stop new dashboard launches immediately while the platform-side command
    // is pending. The command worker clears commandPending only after success.
    account.enabled = false;
    account.commandPending = decision.command;
  }
  account.lastProcessedEventId = event.eventId;
  await account.save();

  if (decision.command) {
    const commandQueue = new CommandQueue(boss);
    await commandQueue.enqueueCommand(decision.command, account);
  }
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
