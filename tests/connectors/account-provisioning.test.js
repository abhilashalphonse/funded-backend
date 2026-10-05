import test from "node:test";
import assert from "node:assert/strict";
import {
  ACG_FUNDED_RISK_POLICY_V1_VERSION,
  ACG_FUNDED_RISK_POLICY_V2_VERSION,
  ACG_FUNDED_V1_EXECUTION_POLICY,
  ACG_FUNDED_V2_EXECUTION_POLICY,
  buildRiskPolicy,
  buildTradingPermissions,
  resolveProvisioningRiskPolicyVersion,
  provisionTradingAccount,
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


test("trading permissions preserve explicit selections and default historical missing values to permissive", () => {
  assert.deepEqual(buildTradingPermissions({ commercialTerms: { newsTrading: false, weekendHolding: true } }), {
    newsTrading: false,
    weekendHolding: true,
    highImpactOnly: true,
    newsRestrictionBeforeMinutes: 5,
    newsRestrictionAfterMinutes: 5,
    closeReduceAlwaysAllowed: true,
    pendingEntriesBlocked: true,
    weekendCloseBufferMinutes: 5,
    weekendBreach: false,
    carryToMaster: true,
  });

  const missing = buildTradingPermissions({ commercialTerms: {} });
  assert.equal(missing.newsTrading, true);
  assert.equal(missing.weekendHolding, true);
});

test('new provisioning rejects missing permissions, while an explicit historical cutoff permits fallback', () => {
  assert.throws(() => buildTradingPermissions({ commercialTerms: {} }, { strict: true }), { code: 'PROVISIONING_CONTRACT_INVALID' });
  assert.equal(buildTradingPermissions({ commercialTerms: {}, createdAt: '2025-01-01' }, { strict: true, legacyBefore: '2026-01-01' }).newsTrading, true);
});

test('Funded provisioning carries purchased permissions and version through Phase 1, Phase 2 and Master', async () => {
  const account = { accountId: 'ACG-contract', ownerExternalRef: 'owner', platform: 'acg-trader', platformAccounts: [],
    accountSize: 100000, initialDeposit: 100000, challengeType: 'TWO_STEP', tradingPermissionsVersion: 7,
    commercialTerms: { newsTrading: false, weekendHolding: true }, rules: { dailyDrawdown: 5, maxDrawdown: 10, phases: [{ phase: 1, profitTarget: 8 }, { phase: 2, profitTarget: 5 }] },
    save: async () => {} };
  const payloads = [];
  const connector = { provisionAccount: async payload => { payloads.push(payload); return { platformAccountId: `trader-${payloads.length}`, raw: { status: 'ACTIVE' } }; } };
  await provisionTradingAccount(account, { phase: 1, connector });
  await provisionTradingAccount(account, { phase: 2, connector });
  await provisionTradingAccount(account, { phase: 2, accountType: 'FUNDED', connector });
  assert.equal(new Set(payloads.map(item => item.externalRef)).size, 3);
  assert.deepEqual(payloads.map(item => item.accountType), ['CHALLENGE', 'CHALLENGE', 'FUNDED']);
  for (const payload of payloads) {
    assert.equal(payload.tradingPermissions.newsTrading, false);
    assert.equal(payload.tradingPermissions.weekendHolding, true);
    assert.equal(payload.tradingPermissionsVersion, 7);
  }
});
