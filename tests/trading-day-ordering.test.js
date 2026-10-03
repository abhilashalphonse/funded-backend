import test from "node:test";
import assert from "node:assert/strict";

import { applyDealEvent, recordTradingDay } from "../src/workers/state-engine/processEvent.js";
import Account from "../src/accounts/account.model.js";

function fakeTradingDayModel() {
  const keys = new Set();
  return {
    async updateOne(scope) {
      keys.add([scope.accountId, scope.phase, scope.platformAccountId, scope.dayKey].join("|"));
      return { acknowledged: true };
    },
    async countDocuments(filter) {
      const prefix = [filter.accountId, filter.phase, filter.platformAccountId].join("|") + "|";
      return [...keys].filter(key => key.startsWith(prefix)).length;
    },
  };
}

test("out-of-order deal delivery counts unique trading days exactly once", async () => {
  const account = {
    accountId: "ACG-DAY-STRESS",
    currentPhase: 1,
    platformAccountId: "platform-p1",
    projections: { tradingDays: 0 },
    lastTradingDay: null,
    lastActiveDay: null,
  };
  const model = fakeTradingDayModel();

  const events = [
    ["evt-tue-1", "2026-09-22T10:00:00.000Z"],
    ["evt-mon-late", "2026-09-21T10:00:00.000Z"],
    ["evt-tue-2", "2026-09-22T12:00:00.000Z"],
    ["evt-mon-retry-shape", "2026-09-21T14:00:00.000Z"],
  ];

  for (const [eventId, timestamp] of events) {
    await recordTradingDay(
      account,
      { eventId, payload: { platformAccountId: "platform-p1" } },
      timestamp.slice(0, 10),
      new Date(timestamp),
      model,
    );
  }

  assert.equal(account.projections.tradingDays, 2);
  assert.equal(account.lastTradingDay, "2026-09-22");
  assert.equal(account.lastActiveDay, "2026-09-22");
});

test("trading-day uniqueness is scoped to phase and platform generation", async () => {
  const account = {
    accountId: "ACG-DAY-GENERATION",
    currentPhase: 1,
    platformAccountId: "platform-p1",
    projections: { tradingDays: 0 },
  };
  const model = fakeTradingDayModel();

  await recordTradingDay(
    account,
    { eventId: "p1", payload: { platformAccountId: "platform-p1" } },
    "2026-09-21",
    new Date("2026-09-21T10:00:00Z"),
    model,
  );
  assert.equal(account.projections.tradingDays, 1);

  account.currentPhase = 2;
  account.platformAccountId = "platform-p2";
  account.projections.tradingDays = 0;

  await recordTradingDay(
    account,
    { eventId: "p2", payload: { platformAccountId: "platform-p2" } },
    "2026-09-21",
    new Date("2026-09-21T11:00:00Z"),
    model,
  );
  assert.equal(account.projections.tradingDays, 1);
});


test("only opening deals create UTC trading days", async () => {
  const account = {
    accountId: "ACG-DAY-OPEN-ONLY",
    currentPhase: 1,
    platformAccountId: "platform-p1",
    projections: { tradingDays: 0 },
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
  };
  const model = fakeTradingDayModel();

  await applyDealEvent(account, {
    eventId: "open-mon",
    occurredAt: "2026-10-05T23:30:00.000Z",
    payload: {
      platformAccountId: "platform-p1",
      type: "OPEN",
      executedAt: "2026-10-05T23:30:00.000Z",
    },
  }, model);
  assert.equal(account.projections.tradingDays, 1);

  await applyDealEvent(account, {
    eventId: "close-tue",
    occurredAt: "2026-10-06T01:00:00.000Z",
    payload: {
      platformAccountId: "platform-p1",
      type: "CLOSE",
      executedAt: "2026-10-06T01:00:00.000Z",
      realizedPnl: 10,
      commission: 0,
    },
  }, model);
  assert.equal(account.projections.tradingDays, 1);

  for (const [eventId, type] of [
    ["partial-close", "PARTIAL_CLOSE"],
    ["reverse-close", "REVERSE_CLOSE"],
    ["stop-loss", "STOP_LOSS"],
    ["take-profit", "TAKE_PROFIT"],
    ["liquidation", "LIQUIDATION"],
  ]) {
    await applyDealEvent(account, {
      eventId,
      occurredAt: "2026-10-06T12:00:00.000Z",
      payload: {
        platformAccountId: "platform-p1",
        type,
        executedAt: "2026-10-06T12:00:00.000Z",
        realizedPnl: 0,
        commission: 0,
      },
    }, model);
  }
  assert.equal(account.projections.tradingDays, 1);

  await applyDealEvent(account, {
    eventId: "reverse-open-tue",
    occurredAt: "2026-10-06T12:00:01.000Z",
    payload: {
      platformAccountId: "platform-p1",
      type: "REVERSE_OPEN",
      executedAt: "2026-10-06T12:00:01.000Z",
    },
  }, model);
  assert.equal(account.projections.tradingDays, 2);
});

test("UTC calendar boundary defines distinct trading days", async () => {
  const account = {
    accountId: "ACG-DAY-UTC-BOUNDARY",
    currentPhase: 1,
    platformAccountId: "platform-p1",
    projections: { tradingDays: 0 },
  };
  const model = fakeTradingDayModel();

  await applyDealEvent(account, {
    eventId: "before-midnight",
    payload: {
      platformAccountId: "platform-p1",
      type: "OPEN",
      executedAt: "2026-10-05T23:59:59.999Z",
    },
  }, model);

  await applyDealEvent(account, {
    eventId: "after-midnight",
    payload: {
      platformAccountId: "platform-p1",
      type: "OPEN",
      executedAt: "2026-10-06T00:00:00.000Z",
    },
  }, model);

  assert.equal(account.projections.tradingDays, 2);
  assert.equal(account.lastTradingDay, "2026-10-06");
});

test("multiple opening deals on the same UTC date count once", async () => {
  const account = {
    accountId: "ACG-DAY-SAME-DAY",
    currentPhase: 1,
    platformAccountId: "platform-p1",
    projections: { tradingDays: 0 },
  };
  const model = fakeTradingDayModel();

  for (const [eventId, executedAt] of [
    ["open-1", "2026-10-05T01:00:00.000Z"],
    ["open-2", "2026-10-05T08:00:00.000Z"],
    ["reverse-open", "2026-10-05T20:00:00.000Z"],
  ]) {
    await applyDealEvent(account, {
      eventId,
      payload: {
        platformAccountId: "platform-p1",
        type: eventId === "reverse-open" ? "REVERSE_OPEN" : "OPEN",
        executedAt,
      },
    }, model);
  }

  assert.equal(account.projections.tradingDays, 1);
});

test("Account schema enforces one active Trial key at the database layer", () => {
  const indexes = Account.schema.indexes();
  const activeTrial = indexes.find(([spec]) => spec.activeTrialKey === 1);
  assert.ok(activeTrial);
  assert.equal(activeTrial[1].unique, true);
  assert.deepEqual(activeTrial[1].partialFilterExpression, {
    activeTrialKey: { $type: "string" },
  });
});
