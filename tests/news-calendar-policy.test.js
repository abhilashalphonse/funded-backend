import test from "node:test";
import assert from "node:assert/strict";
import {
  restrictionFor,
  affectedMarketsFor,
  cacheTtlMs,
} from "../src/apis/services/newsCalendar.service.js";

test("historical accounts without an explicit news setting remain permissive", () => {
  assert.deepEqual(
    restrictionFor({ commercialTerms: {} }, { timestamp: "2026-10-04T13:30:00.000Z" }, "LIVE"),
    { status: "ALLOWED", applies: false },
  );
});

test("restricted accounts use the approved five-minute live window", () => {
  const result = restrictionFor(
    { commercialTerms: { newsTrading: false } },
    { timestamp: "2026-10-04T13:30:00.000Z", allDay: false },
    "LIVE",
  );
  assert.equal(result.status, "RESTRICTED");
  assert.equal(result.applies, true);
  assert.equal(result.beforeMinutes, 5);
  assert.equal(result.afterMinutes, 5);
  assert.equal(result.blockedFrom, "2026-10-04T13:25:00.000Z");
  assert.equal(result.blockedUntil, "2026-10-04T13:35:00.000Z");
});

test("stale calendar data is informative only and never authoritative for restriction", () => {
  const result = restrictionFor(
    { commercialTerms: { newsTrading: false } },
    { timestamp: "2026-10-04T13:30:00.000Z", allDay: false },
    "STALE",
  );
  assert.equal(result.status, "DATA_STALE");
  assert.equal(result.applies, false);
  assert.equal(result.wouldApply, true);
});

test("affected market labels stay narrow and deterministic", () => {
  assert.deepEqual(
    affectedMarketsFor({ currency: "USD", title: "US CPI" }).groups,
    ["USD FX pairs", "Gold (XAUUSD)", "US indices", "DXY"],
  );
  assert.deepEqual(
    affectedMarketsFor({ currency: "USD", title: "EIA Crude Oil Inventories" }).groups,
    ["USOIL", "UKOIL"],
  );
});

test("current-range calendar cache refreshes more aggressively than future ranges", () => {
  const now = new Date("2026-10-04T12:00:00.000Z").getTime();
  assert.equal(cacheTtlMs("2026-10-04", "2026-10-04", now), 60_000);
  assert.equal(cacheTtlMs("2026-10-05", "2026-10-05", now), 10 * 60_000);
});
