import test from "node:test";
import assert from "node:assert/strict";

import { compareTradingPermissions } from "../src/accounts/permission-reconciliation.js";

test("permission reconciliation accepts exact News/Weekend/version matches", () => {
  assert.deepEqual(compareTradingPermissions(
    { newsTrading: false, weekendHolding: true },
    3,
    { newsTrading: false, weekendHolding: true },
    3,
  ), []);
});

test("permission reconciliation reports field and version mismatches", () => {
  assert.deepEqual(compareTradingPermissions(
    { newsTrading: false, weekendHolding: true },
    4,
    { newsTrading: true, weekendHolding: false },
    3,
  ), [
    { field: "newsTrading", expected: false, actual: true },
    { field: "weekendHolding", expected: true, actual: false },
    { field: "tradingPermissionsVersion", expected: 4, actual: 3 },
  ]);
});
