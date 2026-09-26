import Account from "../../accounts/account.model.js";
import AccountTradingDay from "../../accounts/account-trading-day.model.js";
import { evaluateRules } from "./rules.js";
import { resolveDecision } from "./decisions.js";
import { CommandQueue } from "./commandQueue.js";
import { recordAnalyticsEventOnce } from "../../apis/services/analytics.service.js";

const SNAPSHOT_EVENT = "ACG_TRADER_ACCOUNT_SNAPSHOT";
const DEAL_EVENT = "ACG_TRADER_DEAL_CREATED";
const CONTROL_EVENT = "ACG_TRADER_ACCOUNT_CONTROLLED";
const CLOSE_DEAL_TYPES = new Set(["CLOSE", "PARTIAL_CLOSE", "REVERSE_CLOSE", "STOP_LOSS", "TAKE_PROFIT", "LIQUIDATION"]);

export async function processEvent(event, boss, {
  accountModel = Account,
  tradingDayModel = AccountTradingDay,
} = {}) {
  const account = await accountModel.findOne({ accountId: event.aggregateId });
  if (!account) {
    // Events can legitimately outlive a Funded account after local resets,
    // deletions, or lifecycle cleanup. Retrying can never succeed and can
    // starve current projections behind stale work.
    return;
  }

  // Every state-engine write is guarded by the lifecycle state that this
  // worker actually read. Snapshot and control events are allowed to execute
  // concurrently, but only one of them may commit from a given version/state.
  const lifecycleWriteGuard = captureLifecycleWriteGuard(account);

  // ACG Trader account state is authoritative only when the event crossed the
  // signed ACG Trader webhook boundary. The removed legacy /api/trade-webhook
  // path never stamped this metadata, so this also neutralizes any legacy jobs
  // that were queued before the public endpoint was disabled.
  if (
    String(account.platform || "").toLowerCase() === "acg-trader"
    && event?.metadata?.provider !== "acg-trader"
  ) {
    account.lastProcessedEventId = event.eventId;
    await saveAccountConditional(account, accountModel, lifecycleWriteGuard);
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
    await saveAccountConditional(account, accountModel, lifecycleWriteGuard);
    return;
  }

  if (event.eventType === CONTROL_EVENT) {
    const incomingStatus = String(event.payload?.status || "").toUpperCase();
    const controlMetricsStale = isControlMetricsOlderThanLastAuthoritativeSnapshot(account, event);
    if (hasControlMetrics(event.payload) && !controlMetricsStale) {
      applySnapshotEvent(account, event);
      if (event?.payload?.breachEvidence) {
        const valuationTime = controlValuationTime(event);
        if (valuationTime) account.lastPlatformSnapshotAt = valuationTime;
        const valuationSequence = Number(event.payload.breachEvidence.valuationSequence);
        if (Number.isFinite(valuationSequence)) account.lastPlatformSnapshotSequence = valuationSequence;
      }
    }
    applyControlEvent(account, event);

    if (incomingStatus === "BREACHED" && String(account.status || "").toUpperCase() !== "CLOSED") {
      // A Trader breach is terminal. Exact Trader trigger evidence is allowed
      // to enrich an earlier Funded-side breach decision, but a late control
      // event must not roll current account metrics back behind a newer
      // post-liquidation valuation.
      account.status = "BREACHED";
      account.enabled = false;
      account.commandPending = null;
      account.lifecycleOperationId = null;
      account.lifecycleOperationType = null;
      account.lifecycleOperationStartedAt = null;
      if (account.accountMode === "DEMO") account.activeTrialKey = null;

      const breach = buildControlBreachRecord(account, event);
      if (shouldReplaceBreachRecord(account.breach, breach)) {
        account.breach = breach;
        account.projections = account.projections || {};
        account.projections.breachedAt = breach.breachedAt;
      }
    }

    account.lastProcessedEventId = event.eventId;
    await saveAccountConditional(account, accountModel, lifecycleWriteGuard);

    if (
      account.accountMode === "DEMO"
      && incomingStatus === "BREACHED"
    ) {
      await recordAnalyticsEventOnce({
        event: "trial_failed",
        sessionId: `account:${account.accountId}`,
        customer: account.customerId ? { customerId: account.customerId } : null,
        accountId: account.accountId,
        source: "server",
        properties: {
          customerId: account.customerId || undefined,
          ownerExternalRef: account.ownerExternalRef,
          accountSize: account.accountSize,
          challengeType: account.challengeType,
          breachReason: account.breach?.primaryReason || null,
          triggeredRules: account.breach?.triggeredRules || [],
        },
      }, { accountId: account.accountId }).catch(() => {});
    }
    return;
  }

  if (event.eventType === DEAL_EVENT) {
    await applyDealEvent(account, event, tradingDayModel);
    account.lastProcessedEventId = event.eventId;
    await saveAccountConditional(account, accountModel, lifecycleWriteGuard);
    const analyticsCustomer = account.customerId ? { customerId: account.customerId } : null;
    const tradeProperties = {
      customerId: account.customerId || undefined,
      ownerExternalRef: account.ownerExternalRef,
      accountMode: account.accountMode,
      challengeType: account.challengeType,
    };

    await recordAnalyticsEventOnce({
      event: "first_trade",
      sessionId: `account:${account.accountId}`,
      customer: analyticsCustomer,
      accountId: account.accountId,
      source: "server",
      properties: tradeProperties,
    }, { accountId: account.accountId }).catch(() => {});

    if (account.accountMode === "DEMO") {
      await recordAnalyticsEventOnce({
        event: "trial_first_trade",
        sessionId: `account:${account.accountId}`,
        customer: analyticsCustomer,
        accountId: account.accountId,
        source: "server",
        properties: tradeProperties,
      }, { accountId: account.accountId }).catch(() => {});
    }
    return;
  }

  if (event.eventType !== SNAPSHOT_EVENT) {
    // Legacy providers still use the generic projection contract.
    if (event.metadata?.provider === "acg-trader") {
      account.lastProcessedEventId = event.eventId;
      await saveAccountConditional(account, accountModel, lifecycleWriteGuard);
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
      updateLossProjections(account);
      account.lastPlatformSnapshotAt = snapshotTime(event);
      const sequence = snapshotSequence(event);
      if (sequence !== null) account.lastPlatformSnapshotSequence = sequence;
    }
    account.lastProcessedEventId = event.eventId;
    await saveAccountConditional(account, accountModel, lifecycleWriteGuard);
    return;
  }

  if (account.status === "CLOSED") {
    account.lastProcessedEventId = event.eventId;
    await saveAccountConditional(account, accountModel, lifecycleWriteGuard);
    return;
  }

  if (event.eventType === SNAPSHOT_EVENT && !isAuthoritativeTraderSnapshot(event)) {
    // Non-authoritative valuations must never overwrite the Funded dashboard.
    // They may be useful operationally, but risk/account projections only
    // follow complete LIVE ACG Trader valuations.
    account.lastProcessedEventId = event.eventId;
    await saveAccountConditional(account, accountModel, lifecycleWriteGuard);
    return;
  }

  if (event.eventType === SNAPSHOT_EVENT && isOlderThanLastAuthoritativeSnapshot(account, event)) {
    account.lastProcessedEventId = event.eventId;
    await saveAccountConditional(account, accountModel, lifecycleWriteGuard);
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
    await saveAccountConditional(account, accountModel, lifecycleWriteGuard);
    return;
  }

  const rules = evaluateRules(account);
  const decision = resolveDecision(account, rules);

  if (!decision.shouldUpdate) {
    account.lastProcessedEventId = event.eventId;
    await saveAccountConditional(account, accountModel, lifecycleWriteGuard);
    return;
  }

  account.status = decision.newStatus;
  if (decision.newStatus === "BREACHED") {
    account.lifecycleOperationId = null;
    account.lifecycleOperationType = null;
    account.lifecycleOperationStartedAt = null;
    if (account.accountMode === "DEMO") account.activeTrialKey = null;
    if (!account.breach?.breachedAt) {
      const breach = buildBreachRecord(account, decision, event);
      account.breach = breach;
      account.projections = account.projections || {};
      account.projections.breachedAt = breach.breachedAt;
    }
  }
  if (decision.command) {
    // Stop new dashboard launches immediately while the platform-side command
    // is pending. The command worker clears commandPending only after success.
    account.enabled = false;
    account.commandPending = decision.command;
  }
  account.lastProcessedEventId = event.eventId;
  await saveAccountConditional(account, accountModel, lifecycleWriteGuard);

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
      customer: account.customerId ? { customerId: account.customerId } : null,
      accountId: account.accountId,
      source: "server",
      properties: { ...properties, customerId: account.customerId || undefined },
    }, { accountId: account.accountId }).catch(() => {});
    await recordAnalyticsEventOnce({
      event: "trial_completed",
      sessionId: `account:${account.accountId}`,
      customer: account.customerId ? { customerId: account.customerId } : null,
      accountId: account.accountId,
      source: "server",
      properties: { ...properties, customerId: account.customerId || undefined },
    }, { accountId: account.accountId }).catch(() => {});
  }

  if (account.accountMode === "DEMO" && decision.newStatus === "BREACHED") {
    await recordAnalyticsEventOnce({
      event: "trial_failed",
      sessionId: `account:${account.accountId}`,
      customer: account.customerId ? { customerId: account.customerId } : null,
      accountId: account.accountId,
      source: "server",
      properties: {
        customerId: account.customerId || undefined,
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

export function captureLifecycleWriteGuard(account) {
  const version = Number(account?.version ?? 0);
  return {
    version: Number.isFinite(version) && version >= 0 ? version : 0,
    status: String(account?.status || ""),
  };
}

export async function saveAccountConditional(account, accountModel, guard) {
  // Unit tests and non-Mongoose test doubles intentionally keep the old save
  // contract. Production Account documents always expose getChanges() and _id.
  if (
    typeof accountModel?.updateOne !== "function"
    || typeof account?.getChanges !== "function"
    || account?._id == null
  ) {
    await account.save();
    guard.version = Number(account?.version ?? guard.version ?? 0);
    guard.status = String(account?.status || "");
    return;
  }

  const expectedVersion = Number(guard?.version ?? 0);
  const expectedStatus = String(guard?.status || "");
  const rawChanges = account.getChanges();
  const update = {};

  for (const [operator, payload] of Object.entries(rawChanges || {})) {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      update[operator] = { ...payload };
    } else {
      update[operator] = payload;
    }
  }

  // The state engine owns this monotonic lifecycle version. Never allow a
  // document mutation to set/unset/increment it independently of the CAS.
  for (const operator of ["$set", "$unset", "$inc", "$setOnInsert"]) {
    if (!update[operator] || typeof update[operator] !== "object") continue;
    delete update[operator].version;
    if (Object.keys(update[operator]).length === 0) delete update[operator];
  }
  update.$inc = { ...(update.$inc || {}), version: 1 };

  const filter = {
    _id: account._id,
    accountId: account.accountId,
    status: expectedStatus,
  };

  // Older accounts may pre-date persistence of the explicit version field.
  // Treat a missing version as version 0 exactly once; after the first guarded
  // write every subsequent commit must match the stored integer.
  if (expectedVersion === 0) {
    filter.$or = [
      { version: 0 },
      { version: { $exists: false } },
    ];
  } else {
    filter.version = expectedVersion;
  }

  const result = await accountModel.updateOne(filter, update, { runValidators: true });
  const matchedCount = Number(
    result?.matchedCount
    ?? result?.n
    ?? result?.modifiedCount
    ?? 0
  );

  if (matchedCount !== 1) {
    const error = new Error(
      `Lifecycle write conflict for account ${account.accountId}: expected version ${expectedVersion} in state ${expectedStatus}.`
    );
    error.code = "ACCOUNT_LIFECYCLE_WRITE_CONFLICT";
    error.retryable = true;
    throw error;
  }

  account.version = expectedVersion + 1;
  guard.version = account.version;
  guard.status = String(account?.status || "");
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

  const referenceEquity = primaryReason === "MAX_DRAWDOWN"
    ? initialBalance
    : Number(account.dailyStartEquity || initialBalance);

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
    thresholdEquity: finiteOrNull(referenceEquity - limitAmount),
    riskDayKey: account.riskDayKey || event?.payload?.riskDayKey || null,
    valuationSequence: snapshotSequence(event),
    valuedAt: breachedAt,
    reasonCode: "FUNDED_RULE_EVALUATION",
    evidenceSource: "FUNDED_SNAPSHOT",
    floatingPnl: finiteOrNull(account.floatingProfit),
    usedMargin: finiteOrNull(account.margin),
    freeMargin: finiteOrNull(account.marginFree),
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

function updateLossProjections(account) {
  account.projections = account.projections || {};
  const initialBalance = Number(account.initialDeposit || account.accountSize || 0);
  const equity = Number(account.equity || 0);
  const dailyStart = Number(account.dailyStartEquity || initialBalance);
  const balance = Number(account.balance || 0);
  account.projections.profit = balance - initialBalance;
  account.projections.dailyLoss = Math.max(0, dailyStart - equity);
  account.projections.totalLoss = Math.max(0, initialBalance - equity);
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

async function applyDealEvent(account, event, tradingDayModel) {
  const p = event.payload || {};
  const type = String(p.type || "").toUpperCase();
  const executedAt = new Date(p.executedAt || event.occurredAt || event.receivedAt || Date.now());
  const tradingDay = Number.isNaN(executedAt.getTime()) ? null : executedAt.toISOString().slice(0, 10);

  if (tradingDay) {
    await recordTradingDay(account, event, tradingDay, executedAt, tradingDayModel);
  }

  if (!CLOSE_DEAL_TYPES.has(type)) return;
  account.totalTrades = Number(account.totalTrades || 0) + 1;
  const realized = Number(p.realizedPnl || 0) - Number(p.commission || 0);
  if (realized > 0) account.winningTrades = Number(account.winningTrades || 0) + 1;
  else if (realized < 0) account.losingTrades = Number(account.losingTrades || 0) + 1;
}

export async function recordTradingDay(account, event, tradingDay, executedAt, tradingDayModel) {
  if (!tradingDayModel) return;
  const platformAccountId = String(event?.payload?.platformAccountId || account?.platformAccountId || "").trim();
  if (!platformAccountId) return;

  const scope = {
    accountId: String(account.accountId),
    phase: Number(account.currentPhase || 1),
    platformAccountId,
    dayKey: tradingDay,
  };

  try {
    await tradingDayModel.updateOne(
      scope,
      {
        $setOnInsert: {
          ...scope,
          firstDealEventId: event?.eventId || null,
          firstExecutedAt: executedAt,
        },
      },
      { upsert: true },
    );
  } catch (error) {
    // Concurrent first trades on the same UTC day may race the unique index.
    if (error?.code !== 11000) throw error;
  }

  const tradingDays = await tradingDayModel.countDocuments({
    accountId: scope.accountId,
    phase: scope.phase,
    platformAccountId: scope.platformAccountId,
  });

  account.projections = account.projections || {};
  account.projections.tradingDays = Number(tradingDays || 0);
  if (!account.lastTradingDay || tradingDay > account.lastTradingDay) account.lastTradingDay = tradingDay;
  if (!account.lastActiveDay || tradingDay > account.lastActiveDay) account.lastActiveDay = tradingDay;
}

export function buildControlBreachRecord(account, event) {
  const reason = String(event?.payload?.reason || "").toUpperCase();
  const evidence = event?.payload?.breachEvidence || null;
  const primaryReason = evidence?.rule === "MAX_DRAWDOWN" || reason.includes("MAX")
    ? "MAX_DRAWDOWN"
    : "DAILY_DRAWDOWN";
  const breachedAtCandidate = new Date(event?.payload?.breachedAt || event?.occurredAt || event?.timestamp || Date.now());
  const valuedAtCandidate = evidence?.valuedAtMs != null
    ? new Date(Number(evidence.valuedAtMs))
    : breachedAtCandidate;
  const breachedAt = Number.isNaN(breachedAtCandidate.getTime()) ? snapshotTime(event) : breachedAtCandidate;
  const valuedAt = Number.isNaN(valuedAtCandidate.getTime()) ? null : valuedAtCandidate;

  if (evidence) {
    const initialBalance = finiteOrNull(evidence.initialBalance ?? account.initialDeposit ?? account.accountSize);
    const dailyStartEquity = finiteOrNull(evidence.dailyStartEquity ?? account.dailyStartEquity);
    const equity = finiteOrNull(evidence.equity);
    const balance = finiteOrNull(evidence.balance);
    const limitAmount = finiteOrNull(evidence.limitAmount);
    const actualLoss = finiteOrNull(evidence.actualLoss);
    const breachAmount = finiteOrNull(evidence.breachAmount);
    const thresholdEquity = finiteOrNull(evidence.thresholdEquity);
    const dailyLoss = dailyStartEquity != null && equity != null ? Math.max(0, dailyStartEquity - equity) : null;
    const totalLoss = initialBalance != null && equity != null ? Math.max(0, initialBalance - equity) : null;
    const triggeredRules = Array.isArray(evidence.triggeredRules) && evidence.triggeredRules.length
      ? [...new Set(evidence.triggeredRules.map(value => String(value).toUpperCase()))]
      : [primaryReason];
    if (!triggeredRules.includes(primaryReason)) triggeredRules.push(primaryReason);

    return {
      primaryReason,
      triggeredRules,
      breachedAt,
      phase: Number(account.currentPhase || 1),
      balance,
      equity,
      dailyStartEquity,
      initialBalance,
      dailyLoss,
      totalLoss,
      limitAmount,
      actualLoss,
      breachAmount,
      thresholdEquity,
      riskDayKey: evidence.riskDayKey || event?.payload?.riskDayKey || account.riskDayKey || null,
      valuationSequence: Number.isFinite(Number(evidence.valuationSequence)) ? Number(evidence.valuationSequence) : null,
      valuedAt,
      reasonCode: evidence.reason || reason || null,
      evidenceSource: "TRADER_TRIGGER",
      floatingPnl: finiteOrNull(evidence.floatingPnl),
      usedMargin: finiteOrNull(evidence.usedMargin),
      freeMargin: finiteOrNull(evidence.freeMargin),
    };
  }

  return {
    ...buildBreachRecord(
      account,
      { primaryReason, triggeredRules: [primaryReason] },
      { ...event, occurredAt: breachedAt },
    ),
    breachedAt,
    valuedAt: null,
    valuationSequence: null,
    reasonCode: reason || null,
    evidenceSource: "CONTROL_FALLBACK",
  };
}

export function shouldReplaceBreachRecord(existing, candidate) {
  if (!candidate) return false;
  if (!existing?.breachedAt) return true;
  const existingSource = String(existing?.evidenceSource || "").toUpperCase();
  const candidateSource = String(candidate?.evidenceSource || "").toUpperCase();
  if (candidateSource === "TRADER_TRIGGER" && existingSource !== "TRADER_TRIGGER") return true;
  return false;
}

export function controlValuationTime(event) {
  const evidence = event?.payload?.breachEvidence || null;
  const candidate = evidence?.valuedAtMs != null
    ? new Date(Number(evidence.valuedAtMs))
    : new Date(event?.payload?.breachedAt || event?.occurredAt || event?.timestamp || 0);
  return Number.isNaN(candidate.getTime()) ? null : candidate;
}

export function isControlMetricsOlderThanLastAuthoritativeSnapshot(account, event) {
  if (!account?.lastPlatformSnapshotAt) return false;
  const evidence = event?.payload?.breachEvidence || null;
  const candidateTime = controlValuationTime(event);
  if (!candidateTime) return false;

  const currentTime = new Date(account.lastPlatformSnapshotAt);
  if (Number.isNaN(currentTime.getTime())) return false;
  if (candidateTime.getTime() < currentTime.getTime()) return true;
  if (candidateTime.getTime() > currentTime.getTime()) return false;

  const incomingSequence = Number(evidence?.valuationSequence);
  const currentSequence = Number(account.lastPlatformSnapshotSequence);
  if (!Number.isFinite(incomingSequence) || !Number.isFinite(currentSequence)) return false;
  return incomingSequence <= currentSequence;
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
