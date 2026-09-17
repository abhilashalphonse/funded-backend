import test from "node:test";
import assert from "node:assert/strict";
import { isAuthoritativeTraderSnapshot } from "../../src/workers/state-engine/processEvent.js";

const base = {
  eventType: "ACG_TRADER_ACCOUNT_SNAPSHOT",
  payload: { valuationStatus: "LIVE", complete: true },
};

test("live complete ACG Trader snapshot is authoritative for Funded risk decisions", () => {
  assert.equal(isAuthoritativeTraderSnapshot(base), true);
});

test("stale ACG Trader valuation cannot trigger Funded risk decisions", () => {
  assert.equal(isAuthoritativeTraderSnapshot({ ...base, payload: { valuationStatus: "STALE", complete: true } }), false);
});

test("incomplete ACG Trader valuation cannot trigger Funded risk decisions", () => {
  assert.equal(isAuthoritativeTraderSnapshot({ ...base, payload: { valuationStatus: "LIVE", complete: false } }), false);
});

test("non-snapshot provider events are not blocked by valuation authority guard", () => {
  assert.equal(isAuthoritativeTraderSnapshot({ eventType: "ACG_TRADER_DEAL_CREATED", payload: {} }), true);
});
