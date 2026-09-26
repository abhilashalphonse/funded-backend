import test from "node:test";
import assert from "node:assert/strict";
import {
  ACG_FUNDED_RISK_POLICY_V1_VERSION,
  ACG_FUNDED_RISK_POLICY_V2_VERSION,
  ACG_FUNDED_V1_EXECUTION_POLICY,
  ACG_FUNDED_V2_EXECUTION_POLICY,
  buildRiskPolicy,
  resolveProvisioningRiskPolicyVersion,
} from "../../src/connectors/trading/account-provisioning.js";

test("risk policy converts Funded percentage rules into account-specific execution limits", () => {
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
    ...ACG_FUNDED_V1_EXECUTION_POLICY,
    breachAction: "LIQUIDATE_AND_LOCK",
  });
  assert.equal(buildRiskPolicy(account, 2).profitTarget, "5000");
});

test("funded account risk policy keeps loss limits but has no evaluation profit target", () => {
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
    ...ACG_FUNDED_V1_EXECUTION_POLICY,
    breachAction: "LIQUIDATE_AND_LOCK",
  });
});

test("shared execution percentages are copied into each account while monetary limits remain account-specific", () => {
  const small = {
    accountSize: 5000,
    initialDeposit: 5000,
    currentPhase: 1,
    rules: {
      dailyDrawdown: 3,
      maxDrawdown: 6,
      phases: [{ phase: 1, profitTarget: 10 }],
    },
  };
  const large = {
    accountSize: 100000,
    initialDeposit: 100000,
    currentPhase: 1,
    rules: {
      dailyDrawdown: 3,
      maxDrawdown: 6,
      phases: [{ phase: 1, profitTarget: 10 }],
    },
  };

  const smallPolicy = buildRiskPolicy(small, 1);
  const largePolicy = buildRiskPolicy(large, 1);

  assert.equal(smallPolicy.dailyLoss.limit, "150");
  assert.equal(largePolicy.dailyLoss.limit, "3000");
  assert.equal(smallPolicy.maxLoss.limit, "300");
  assert.equal(largePolicy.maxLoss.limit, "6000");

  for (const [key, value] of Object.entries(ACG_FUNDED_V1_EXECUTION_POLICY)) {
    assert.equal(smallPolicy[key], value);
    assert.equal(largePolicy[key], value);
  }
});


test("V2 provisioning explicitly clears only the five approved execution restrictions", () => {
  const account = {
    accountSize: 100000,
    initialDeposit: 100000,
    currentPhase: 1,
    rules: {
      dailyDrawdown: 3,
      maxDrawdown: 6,
      phases: [{ phase: 1, profitTarget: 10 }],
    },
  };

  const policy = buildRiskPolicy(account, 1, {
    riskPolicyVersion: ACG_FUNDED_RISK_POLICY_V2_VERSION,
  });

  assert.equal(policy.maxRiskPerTradePercent, null);
  assert.equal(policy.maxAggregateRiskPercent, null);
  assert.equal(policy.maxMarginUsagePercent, null);
  assert.equal(policy.maxSingleOrderMarginPercentOfFree, null);
  assert.equal(policy.maxSymbolMarginPercentOfPermitted, null);
  assert.equal(policy.maxOpenPositions, 10);
  assert.equal(policy.maxPositionsPerSymbol, 3);
  assert.equal(policy.maxPendingOrders, 10);
  assert.equal(policy.maxPendingOrdersPerSymbol, 3);
  assert.equal(policy.dailyLoss.limit, "3000");
  assert.equal(policy.maxLoss.limit, "6000");
  assert.equal(policy.profitTarget, "10000");

  assert.deepEqual(
    Object.fromEntries(Object.entries(policy).filter(([key]) => key in ACG_FUNDED_V2_EXECUTION_POLICY)),
    ACG_FUNDED_V2_EXECUTION_POLICY,
  );
});

test("new V2 provisioning is rollout-gated so production can remain V1 until staging validation", () => {
  assert.equal(
    resolveProvisioningRiskPolicyVersion({}),
    ACG_FUNDED_RISK_POLICY_V1_VERSION,
  );
  assert.equal(
    resolveProvisioningRiskPolicyVersion({ ACG_FUNDED_RISK_POLICY_VERSION: "ACG_FUNDED_V2" }),
    ACG_FUNDED_RISK_POLICY_V2_VERSION,
  );
  assert.throws(
    () => resolveProvisioningRiskPolicyVersion({ ACG_FUNDED_RISK_POLICY_VERSION: "ACG_FUNDED_V3" }),
    error => error.code === "INVALID_ACG_FUNDED_RISK_POLICY_VERSION",
  );
});
