import mongoose from "mongoose";
import Account from "../accounts/account.model.js";
import AccountTradingDay from "../accounts/account-trading-day.model.js";
import Event from "../events/event.model.js";

const DEAL_EVENT = "ACG_TRADER_DEAL_CREATED";
const OPEN_DEAL_TYPES = new Set(["OPEN", "REVERSE_OPEN"]);
const AUTO_RECONCILE_STATUSES = new Set(["ACTIVE", "PHASE_2"]);
const MAX_SYNC_ATTEMPTS = 3;

export function deriveCanonicalTradingDays(events = [], platformAccountId) {
  const targetPlatformAccountId = String(platformAccountId || "").trim();
  const days = new Map();

  for (const event of events) {
    if (String(event?.eventType || "") !== DEAL_EVENT) continue;
    if (String(event?.payload?.platformAccountId || "").trim() !== targetPlatformAccountId) continue;

    const type = String(event?.payload?.type || "").toUpperCase();
    if (!OPEN_DEAL_TYPES.has(type)) continue;

    // Match the live state-engine semantics exactly: if executedAt is present
    // but invalid, the deal does not qualify through an occurredAt fallback.
    const rawTimestamp = event?.payload?.executedAt || event?.occurredAt || event?.receivedAt || 0;
    const executedAt = new Date(rawTimestamp);
    if (Number.isNaN(executedAt.getTime())) continue;

    const dayKey = executedAt.toISOString().slice(0, 10);
    const candidate = {
      dayKey,
      eventId: event?.eventId || null,
      executedAt,
    };

    const existing = days.get(dayKey);
    if (
      !existing
      || candidate.executedAt.getTime() < existing.executedAt.getTime()
      || (
        candidate.executedAt.getTime() === existing.executedAt.getTime()
        && String(candidate.eventId || "") < String(existing.eventId || "")
      )
    ) {
      days.set(dayKey, candidate);
    }
  }

  return days;
}

export function buildTradingDayReconciliationPlan({
  rows = [],
  events = [],
  platformAccountId,
} = {}) {
  const canonical = deriveCanonicalTradingDays(events, platformAccountId);
  const rowsByDay = new Map(rows.map(row => [String(row.dayKey), row]));
  const hasAnyDealHistory = events.some(event =>
    String(event?.eventType || "") === DEAL_EVENT
    && String(event?.payload?.platformAccountId || "").trim() === String(platformAccountId || "").trim()
  );

  if (rows.length > 0 && !hasAnyDealHistory) {
    return {
      safeToMutate: false,
      reason: "DEAL_HISTORY_MISSING",
      canonical,
      staleRows: [],
      uncertainRows: rows,
      missingDays: [],
      provenanceFixes: [],
    };
  }

  const eventsById = new Map(
    events
      .filter(event => event?.eventId)
      .map(event => [String(event.eventId), event])
  );
  const staleRows = [];
  const uncertainRows = [];

  for (const row of rows) {
    if (canonical.has(String(row.dayKey))) continue;

    const firstDealEventId = row?.firstDealEventId == null ? null : String(row.firstDealEventId);
    const provenanceEvent = firstDealEventId ? eventsById.get(firstDealEventId) : null;
    const provenanceType = String(provenanceEvent?.payload?.type || "").toUpperCase();

    // A stale day is safe to delete only when its original provenance event is
    // still durable and proves it was a non-opening deal. Missing provenance
    // means event history may be incomplete, so stop rather than guessing.
    if (provenanceEvent && !OPEN_DEAL_TYPES.has(provenanceType)) staleRows.push(row);
    else uncertainRows.push(row);
  }

  if (uncertainRows.length) {
    return {
      safeToMutate: false,
      reason: "DEAL_HISTORY_INCOMPLETE",
      canonical,
      staleRows: [],
      uncertainRows,
      missingDays: [],
      provenanceFixes: [],
    };
  }

  const missingDays = [...canonical.values()].filter(day => !rowsByDay.has(day.dayKey));
  const provenanceFixes = [];

  for (const [dayKey, day] of canonical) {
    const row = rowsByDay.get(dayKey);
    if (!row) continue;

    const currentEventId = row?.firstDealEventId == null ? null : String(row.firstDealEventId);
    const currentTime = row?.firstExecutedAt ? new Date(row.firstExecutedAt).getTime() : null;
    if (
      currentEventId !== String(day.eventId || "")
      || !Number.isFinite(currentTime)
      || currentTime !== day.executedAt.getTime()
    ) {
      provenanceFixes.push({ row, canonical: day });
    }
  }

  return {
    safeToMutate: true,
    reason: null,
    canonical,
    staleRows,
    uncertainRows: [],
    missingDays,
    provenanceFixes,
  };
}

export async function auditAndReconcileHistoricalTradingDays({
  apply = false,
  accountId = null,
  afterAccountId = null,
  limit = null,
  accountModel = Account,
  tradingDayModel = AccountTradingDay,
  eventModel = Event,
} = {}) {
  const query = {
    platform: "acg-trader",
    platformAccountId: mongoose.trusted({ $type: "string" }),
  };
  if (accountId) query.accountId = String(accountId);
  if (!accountId && afterAccountId) query.accountId = mongoose.trusted({ $gt: String(afterAccountId) });

  let accountQuery = accountModel.find(query)
    .sort({ accountId: 1 })
    .select("accountId platform platformAccountId platformAccounts currentPhase status version projections.tradingDays lastTradingDay lastActiveDay");

  if (Number.isInteger(limit) && limit > 0) accountQuery = accountQuery.limit(limit);
  const accounts = await accountQuery.lean();

  const records = [];
  for (const account of accounts) {
    records.push(await reconcileOneAccount({
      account,
      apply,
      accountModel,
      tradingDayModel,
      eventModel,
    }));
  }

  const summary = summarize(records);
  return {
    records,
    summary,
    nextCursor: accounts.length ? accounts[accounts.length - 1].accountId : null,
  };
}

async function reconcileOneAccount({
  account,
  apply,
  accountModel,
  tradingDayModel,
  eventModel,
}) {
  const accountId = String(account.accountId);
  const phase = Number(account.currentPhase || 1);
  const platformAccountId = String(account.platformAccountId || "").trim();
  const status = String(account.status || "").toUpperCase();
  const autoMutable = AUTO_RECONCILE_STATUSES.has(status);

  const scope = { accountId, phase, platformAccountId };
  let snapshot = await readCanonicalSnapshot({ scope, tradingDayModel, eventModel });
  let plan = buildTradingDayReconciliationPlan({
    rows: snapshot.rows,
    events: snapshot.events,
    platformAccountId,
  });

  const record = {
    accountId,
    phase,
    platformAccountId,
    status,
    mode: apply ? "APPLY" : "DRY_RUN",
    autoMutable,
    safeToMutate: plan.safeToMutate,
    reason: plan.reason,
    before: metrics(snapshot.rows, plan),
    changed: false,
    projectionUpdated: false,
    verified: false,
    manualReview: false,
    verificationFailure: false,
    after: null,
  };

  if (!plan.safeToMutate) {
    record.manualReview = true;
    record.after = record.before;
    return record;
  }

  const needsCanonicalChange = hasPlanChanges(plan);
  if (!autoMutable && needsCanonicalChange) {
    // Never roll a lifecycle state backward automatically. Accounts that have
    // already PASSED / entered review / become funded are reported for manual
    // review if historical minimum-day evidence is suspect.
    record.manualReview = true;
    record.reason = "NON_ACTIVE_ACCOUNT_REQUIRES_MANUAL_REVIEW";
    record.after = record.before;
    return record;
  }

  if (!apply) {
    record.verified = !needsCanonicalChange;
    record.after = record.before;
    return record;
  }

  if (autoMutable) {
    for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
      if (!plan.safeToMutate) break;
      if (!hasPlanChanges(plan)) break;

      await applyCanonicalRows({ scope, plan, tradingDayModel });
      record.changed = true;

      snapshot = await readCanonicalSnapshot({ scope, tradingDayModel, eventModel });
      plan = buildTradingDayReconciliationPlan({
        rows: snapshot.rows,
        events: snapshot.events,
        platformAccountId,
      });
    }

    // One final canonical read catches a deal that arrived during a previous
    // repair pass. Immutable DEAL_CREATED is persisted before state projection,
    // so this either preserves/restores the day or the normal state worker will.
    snapshot = await readCanonicalSnapshot({ scope, tradingDayModel, eventModel });
    plan = buildTradingDayReconciliationPlan({
      rows: snapshot.rows,
      events: snapshot.events,
      platformAccountId,
    });

    record.safeToMutate = plan.safeToMutate;
    record.reason = plan.reason;
    record.verified = plan.safeToMutate && !hasPlanChanges(plan);

    if (!record.verified) {
      record.verificationFailure = true;
      record.manualReview = true;
      record.after = metrics(snapshot.rows, plan);
      return record;
    }

    const projectionResult = await updateCurrentPhaseProjection({
      accountId,
      phase,
      platformAccountId,
      rows: snapshot.rows,
      accountModel,
    });
    record.projectionUpdated = projectionResult.updated;
    if (!projectionResult.ok) {
      record.manualReview = true;
      record.reason = projectionResult.reason;
    }
  }

  record.after = metrics(snapshot.rows, plan);
  return record;
}

async function readCanonicalSnapshot({ scope, tradingDayModel, eventModel }) {
  const [rows, events] = await Promise.all([
    tradingDayModel.find(scope)
      .sort({ dayKey: 1 })
      .select("_id accountId phase platformAccountId dayKey firstDealEventId firstExecutedAt createdAt")
      .lean(),
    eventModel.find({
      aggregateId: scope.accountId,
      eventType: DEAL_EVENT,
      "payload.platformAccountId": scope.platformAccountId,
    })
      .sort({ occurredAt: 1, _id: 1 })
      .select("eventId eventType occurredAt receivedAt payload.platformAccountId payload.type payload.executedAt")
      .lean(),
  ]);

  return { rows, events };
}

async function applyCanonicalRows({ scope, plan, tradingDayModel }) {
  if (!plan.safeToMutate) return;

  if (plan.staleRows.length) {
    await tradingDayModel.deleteMany({
      _id: mongoose.trusted({ $in: plan.staleRows.map(row => row._id) }),
      accountId: scope.accountId,
      phase: scope.phase,
      platformAccountId: scope.platformAccountId,
    });
  }

  for (const day of plan.canonical.values()) {
    await tradingDayModel.updateOne(
      { ...scope, dayKey: day.dayKey },
      {
        $setOnInsert: {
          ...scope,
          dayKey: day.dayKey,
        },
        $set: {
          firstDealEventId: day.eventId,
          firstExecutedAt: day.executedAt,
        },
      },
      { upsert: true },
    );
  }
}

async function updateCurrentPhaseProjection({
  accountId,
  phase,
  platformAccountId,
  rows,
  accountModel,
}) {
  const dayKeys = rows.map(row => String(row.dayKey)).sort();
  const tradingDays = dayKeys.length;
  const latestDay = dayKeys.length ? dayKeys[dayKeys.length - 1] : null;

  for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
    const current = await accountModel.findOne({ accountId })
      .select("accountId currentPhase platformAccountId status version projections.tradingDays lastTradingDay lastActiveDay")
      .lean();

    if (!current) return { ok: false, updated: false, reason: "ACCOUNT_DISAPPEARED" };

    if (
      Number(current.currentPhase || 1) !== phase
      || String(current.platformAccountId || "") !== platformAccountId
      || !AUTO_RECONCILE_STATUSES.has(String(current.status || "").toUpperCase())
    ) {
      return { ok: false, updated: false, reason: "ACCOUNT_LIFECYCLE_CHANGED_DURING_RECONCILIATION" };
    }

    const alreadyCanonical = Number(current?.projections?.tradingDays || 0) === tradingDays
      && (current.lastTradingDay ?? null) === latestDay
      && (current.lastActiveDay ?? null) === latestDay;
    if (alreadyCanonical) return { ok: true, updated: false, reason: null };

    const expectedVersion = Number(current.version ?? 0);
    const filter = {
      accountId,
      currentPhase: phase,
      platformAccountId,
      status: current.status,
    };
    if (expectedVersion === 0) {
      filter.$or = [{ version: 0 }, { version: mongoose.trusted({ $exists: false }) }];
    } else {
      filter.version = expectedVersion;
    }

    const result = await accountModel.updateOne(
      filter,
      {
        $set: {
          "projections.tradingDays": tradingDays,
          lastTradingDay: latestDay,
          lastActiveDay: latestDay,
        },
        $inc: { version: 1 },
      },
      { runValidators: true },
    );

    if (Number(result?.matchedCount ?? result?.n ?? 0) === 1) {
      return { ok: true, updated: true, reason: null };
    }
  }

  return { ok: false, updated: false, reason: "ACCOUNT_WRITE_CONFLICT" };
}

function hasPlanChanges(plan) {
  return Boolean(
    plan.staleRows.length
    || plan.missingDays.length
    || plan.provenanceFixes.length
  );
}

function metrics(rows, plan) {
  const dayKeys = rows.map(row => String(row.dayKey)).sort();
  return {
    storedDays: rows.length,
    canonicalDays: plan.canonical.size,
    staleDays: plan.staleRows.map(row => String(row.dayKey)).sort(),
    missingDays: plan.missingDays.map(day => day.dayKey).sort(),
    provenanceFixes: plan.provenanceFixes.map(item => String(item.row.dayKey)).sort(),
    uncertainDays: (plan.uncertainRows || []).map(row => String(row.dayKey)).sort(),
    latestStoredDay: dayKeys.length ? dayKeys[dayKeys.length - 1] : null,
  };
}

function summarize(records) {
  return {
    accountsScanned: records.length,
    activeAccounts: records.filter(record => record.autoMutable).length,
    accountsNeedingCanonicalChange: records.filter(record =>
      record.before.staleDays.length
      || record.before.missingDays.length
      || record.before.provenanceFixes.length
    ).length,
    staleDaysFound: records.reduce((sum, record) => sum + record.before.staleDays.length, 0),
    missingDaysFound: records.reduce((sum, record) => sum + record.before.missingDays.length, 0),
    provenanceFixesFound: records.reduce((sum, record) => sum + record.before.provenanceFixes.length, 0),
    uncertainDaysFound: records.reduce((sum, record) => sum + (record.before.uncertainDays || []).length, 0),
    accountsChanged: records.filter(record => record.changed).length,
    projectionsUpdated: records.filter(record => record.projectionUpdated).length,
    manualReviewRequired: records.filter(record => record.manualReview).length,
    verificationFailures: records.filter(record => record.verificationFailure).length,
  };
}

export {
  AUTO_RECONCILE_STATUSES,
  DEAL_EVENT,
  OPEN_DEAL_TYPES,
};
