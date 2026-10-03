import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTradingDayReconciliationPlan,
  deriveCanonicalTradingDays,
} from "../src/maintenance/tradingDayReconciliation.js";

function deal({ eventId, type, executedAt, occurredAt = executedAt, platformAccountId = "platform-p1" }) {
  return {
    eventId,
    eventType: "ACG_TRADER_DEAL_CREATED",
    occurredAt,
    receivedAt: occurredAt,
    payload: {
      platformAccountId,
      type,
      executedAt,
    },
  };
}

test("canonical trading days include only opening exposure", () => {
  const events = [
    deal({ eventId: "open-mon", type: "OPEN", executedAt: "2026-10-05T23:00:00.000Z" }),
    deal({ eventId: "close-tue", type: "CLOSE", executedAt: "2026-10-06T01:00:00.000Z" }),
    deal({ eventId: "sl-tue", type: "STOP_LOSS", executedAt: "2026-10-06T02:00:00.000Z" }),
    deal({ eventId: "reverse-open-wed", type: "REVERSE_OPEN", executedAt: "2026-10-07T08:00:00.000Z" }),
  ];

  const days = deriveCanonicalTradingDays(events, "platform-p1");
  assert.deepEqual([...days.keys()], ["2026-10-05", "2026-10-07"]);
  assert.equal(days.get("2026-10-05").eventId, "open-mon");
  assert.equal(days.get("2026-10-07").eventId, "reverse-open-wed");
});

test("multiple openings on one UTC day keep the earliest opening provenance", () => {
  const events = [
    deal({ eventId: "late-open", type: "OPEN", executedAt: "2026-10-05T20:00:00.000Z" }),
    deal({ eventId: "early-open", type: "OPEN", executedAt: "2026-10-05T01:00:00.000Z" }),
  ];

  const days = deriveCanonicalTradingDays(events, "platform-p1");
  assert.equal(days.size, 1);
  assert.equal(days.get("2026-10-05").eventId, "early-open");
  assert.equal(days.get("2026-10-05").executedAt.toISOString(), "2026-10-05T01:00:00.000Z");
});

test("invalid present executedAt does not silently fall back to occurredAt", () => {
  const events = [
    deal({
      eventId: "invalid-executed-at",
      type: "OPEN",
      executedAt: "not-a-date",
      occurredAt: "2026-10-05T01:00:00.000Z",
    }),
  ];

  const days = deriveCanonicalTradingDays(events, "platform-p1");
  assert.equal(days.size, 0);
});

test("reconciliation plan removes close-only days and restores missing opening days", () => {
  const rows = [
    { _id: "row-mon", dayKey: "2026-10-05", firstDealEventId: "close-mon", firstExecutedAt: new Date("2026-10-05T23:00:00.000Z") },
    { _id: "row-tue", dayKey: "2026-10-06", firstDealEventId: "close-tue", firstExecutedAt: new Date("2026-10-06T01:00:00.000Z") },
  ];
  const events = [
    deal({ eventId: "open-mon", type: "OPEN", executedAt: "2026-10-05T10:00:00.000Z" }),
    deal({ eventId: "close-tue", type: "CLOSE", executedAt: "2026-10-06T01:00:00.000Z" }),
    deal({ eventId: "open-wed", type: "OPEN", executedAt: "2026-10-07T10:00:00.000Z" }),
  ];

  const plan = buildTradingDayReconciliationPlan({ rows, events, platformAccountId: "platform-p1" });
  assert.equal(plan.safeToMutate, true);
  assert.deepEqual(plan.staleRows.map(row => row.dayKey), ["2026-10-06"]);
  assert.deepEqual(plan.missingDays.map(day => day.dayKey), ["2026-10-07"]);
  assert.deepEqual(plan.provenanceFixes.map(item => item.row.dayKey), ["2026-10-05"]);
});

test("reconciliation refuses destructive mutation when stored days have no deal history", () => {
  const rows = [
    { _id: "row-mon", dayKey: "2026-10-05", firstDealEventId: "unknown", firstExecutedAt: new Date("2026-10-05T10:00:00.000Z") },
  ];

  const plan = buildTradingDayReconciliationPlan({ rows, events: [], platformAccountId: "platform-p1" });
  assert.equal(plan.safeToMutate, false);
  assert.equal(plan.reason, "DEAL_HISTORY_MISSING");
  assert.equal(plan.staleRows.length, 0);
});