import test from "node:test";
import assert from "node:assert/strict";

import { recordTradingDay } from "../src/workers/state-engine/processEvent.js";
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

test("Account schema enforces one active Trial key at the database layer", () => {
  const indexes = Account.schema.indexes();
  const activeTrial = indexes.find(([spec]) => spec.activeTrialKey === 1);
  assert.ok(activeTrial);
  assert.equal(activeTrial[1].unique, true);
  assert.deepEqual(activeTrial[1].partialFilterExpression, {
    activeTrialKey: { $type: "string" },
  });
});
