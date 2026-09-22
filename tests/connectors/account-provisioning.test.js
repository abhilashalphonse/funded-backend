import test from "node:test";
import assert from "node:assert/strict";
import { buildRiskPolicy } from "../../src/connectors/trading/account-provisioning.js";

test("risk policy converts Funded percentage rules into execution currency limits", () => {
  const account = {
    accountSize: 100000,
    initialDeposit: 100000,
    currentPhase: 1,
    rules: {
      dailyDrawdown: 3,
      maxDrawdown: 6,
      phases: [
        { phase: 1, profitTarget: 10 },
        { phase: 2, profitTarget: 5 },
      ],
    },
  };

  assert.deepEqual(buildRiskPolicy(account, 1), {
    dailyLoss: { limit: "3000", reference: "DAILY_START_EQUITY" },
    maxLoss: { limit: "6000", reference: "INITIAL_BALANCE" },
    profitTarget: "10000",
    maxRiskPerTradePercent: null,
    maxAggregateRiskPercent: null,
    breachAction: "LIQUIDATE_AND_LOCK",
  });
  assert.equal(buildRiskPolicy(account, 2).profitTarget, "5000");
});

test("funded risk policy keeps loss limits but has no evaluation profit target", () => {
  const account = {
    accountSize: 100000,
    initialDeposit: 100000,
    currentPhase: 2,
    rules: {
      dailyDrawdown: 5,
      maxDrawdown: 10,
      phases: [{ phase: 2, profitTarget: 8 }],
    },
  };

  assert.deepEqual(buildRiskPolicy(account, 2, { includeProfitTarget: false }), {
    dailyLoss: { limit: "5000", reference: "DAILY_START_EQUITY" },
    maxLoss: { limit: "10000", reference: "INITIAL_BALANCE" },
    maxRiskPerTradePercent: null,
    maxAggregateRiskPercent: null,
    breachAction: "LIQUIDATE_AND_LOCK",
  });
});
