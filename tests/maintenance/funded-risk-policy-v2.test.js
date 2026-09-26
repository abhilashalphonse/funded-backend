import test from "node:test";
import assert from "node:assert/strict";
import {
  ACG_FUNDED_RISK_POLICY_V1_VERSION,
  ACG_FUNDED_RISK_POLICY_V2_VERSION,
  ACG_FUNDED_V1_EXECUTION_POLICY,
  ACG_FUNDED_V2_EXECUTION_POLICY,
} from "../../src/connectors/trading/account-provisioning.js";
import {
  ACG_FUNDED_V2_MIGRATION_ID,
  ACG_FUNDED_V2_TRANSITION_POLICY,
  auditAndMigrateFundedRiskPolicyV2,
  compareMigrationInvariants,
  compareV2DisabledExecutionPolicy,
  migrationObservationSnapshot,
} from "../../src/maintenance/fundedRiskPolicyV2.js";

function accountModel(rows) {
  return {
    find(filter) {
      assert.deepEqual(filter, { platform: "acg-trader" });
      return {
        select(fields) {
          assert.match(fields, /platformAccounts/);
          assert.match(fields, /accountMode/);
          return this;
        },
        async lean() {
          return rows;
        },
      };
    },
  };
}

function fundedRow({
  accountId = "ACG-1",
  platformAccountId = "trader-1",
  accountType = "CHALLENGE",
  platformStatus = "ACTIVE",
  status = "ACTIVE",
  phase = 1,
} = {}) {
  return {
    accountId,
    status,
    currentPhase: phase,
    accountMode: accountType === "DEMO" ? "DEMO" : "CHALLENGE",
    platformAccountId,
    platformAccounts: [{
      platformAccountId,
      phase,
      accountType,
      status: platformStatus,
    }],
  };
}

function observability({
  version = ACG_FUNDED_RISK_POLICY_V1_VERSION,
  policy = ACG_FUNDED_V1_EXECUTION_POLICY,
  accountType = "CHALLENGE",
  status = "ACTIVE",
  tradingEnabled = true,
  provisioningContractHash = "hash-v1",
  financialRevision = 7,
  riskProcessingState = "RESOLVED",
  riskUnresolvedReason = null,
  marginStopOut = { state: "NONE", episodeId: null, levelPercent: "50" },
  balance = "100000",
  equity = "99000",
  floatingPnl = "-1000",
  usedMargin = "5000",
  freeMargin = "94000",
  dailyStartEquity = "100000",
  riskDayKey = "2026-09-26",
  capabilities = null,
  policyTransitions = [],
  openPositions = [],
  orders = [],
} = {}) {
  const v2 = version === ACG_FUNDED_RISK_POLICY_V2_VERSION;
  return {
    account: {
      id: "trader-1",
      accountType,
      status,
      tradingEnabled,
      federationEnabled: true,
      provisioningContractHash,
      financialRevision,
      riskDayKey,
      riskTimezone: "UTC",
      riskProcessingState,
      riskUnresolvedReason,
      marginStopOut,
      state: {
        initialBalance: "100000",
        balance,
        equity,
        floatingPnl,
        realizedPnlToday: "0",
        usedMargin,
        freeMargin,
        marginLevel: usedMargin === "0" ? null : String(Number(equity) / Number(usedMargin) * 100),
        dailyStartEquity,
      },
      riskPolicy: {
        dailyLoss: { limit: "3000", reference: "DAILY_START_EQUITY" },
        maxLoss: { limit: "6000", reference: "INITIAL_BALANCE" },
        profitTarget: "10000",
        breachAction: "LIQUIDATE_AND_LOCK",
        ...policy,
      },
      challenge: { riskPolicyVersion: version },
      capabilities: capabilities ?? {
        policyVersion: version,
        fundedV2Confirmed: v2,
        optionalStopLoss: v2,
        manualLotWithoutStopLoss: v2,
        riskPercentSizing: true,
        riskPercentSizingRequiresStopDistance: true,
        marginStopOutLevelPercent: "50",
      },
    },
    openPositions,
    closedPositions: [],
    deals: [],
    orders,
    lifecycle: [],
    policyTransitions,
  };
}

function completedTransition(migrationId, overrides = {}) {
  return {
    id: "transition-doc-1",
    transitionId: "transition-1",
    migrationId,
    fromVersion: ACG_FUNDED_RISK_POLICY_V1_VERSION,
    toVersion: ACG_FUNDED_RISK_POLICY_V2_VERSION,
    effectiveRiskSequence: 21,
    effectiveFinancialRevision: 7,
    originalProvisioningContractHash: "hash-v1",
    preservedStateHashBefore: "same-state-hash",
    preservedStateHashAfter: "same-state-hash",
    status: "COMPLETED",
    verifiedAt: "2026-09-26T20:00:00.000Z",
  };
}

test("V2 comparison requires every disabled field to exist explicitly as null", () => {
  const exact = compareV2DisabledExecutionPolicy(ACG_FUNDED_V2_EXECUTION_POLICY);
  assert.deepEqual(exact, { missing: [], mismatches: [] });

  const missingPolicy = { ...ACG_FUNDED_V2_EXECUTION_POLICY };
  delete missingPolicy.maxAggregateRiskPercent;
  const missing = compareV2DisabledExecutionPolicy(missingPolicy);
  assert.deepEqual(missing.missing, [{
    key: "maxAggregateRiskPercent",
    expected: null,
    actual: "MISSING",
  }]);

  const mismatch = compareV2DisabledExecutionPolicy({
    ...ACG_FUNDED_V2_EXECUTION_POLICY,
    maxMarginUsagePercent: 50,
  });
  assert.deepEqual(mismatch.mismatches, [{
    key: "maxMarginUsagePercent",
    expected: null,
    actual: "50",
  }]);
});

test("dry run identifies eligible Trial, Challenge and Master accounts without mutating Trader", async () => {
  const rows = [
    fundedRow({ accountId: "TRIAL-1", platformAccountId: "trader-demo", accountType: "DEMO" }),
    fundedRow({ accountId: "CH-1", platformAccountId: "trader-challenge", accountType: "CHALLENGE" }),
    fundedRow({ accountId: "MASTER-1", platformAccountId: "trader-master", accountType: "FUNDED", status: "FUNDED" }),
  ];
  let transitionCalls = 0;
  const typeById = new Map([
    ["trader-demo", "DEMO"],
    ["trader-challenge", "CHALLENGE"],
    ["trader-master", "FUNDED"],
  ]);
  const connector = {
    async adminObservability({ platformAccountId }) {
      return observability({ accountType: typeById.get(platformAccountId) });
    },
    async transitionRiskPolicy() {
      transitionCalls += 1;
    },
  };

  const result = await auditAndMigrateFundedRiskPolicyV2({
    accountModel: accountModel(rows),
    connector,
    apply: false,
    migrationId: "staging-v2-dry-run",
  });

  assert.equal(transitionCalls, 0);
  assert.equal(result.summary.tradingAccountsAudited, 3);
  assert.equal(result.summary.eligibleV1Accounts, 3);
  assert.equal(result.summary.accountsWouldMigrate, 3);
  assert.deepEqual(result.records.map(record => record.action), [
    "WOULD_MIGRATE",
    "WOULD_MIGRATE",
    "WOULD_MIGRATE",
  ]);
});

test("apply migrates V1 policy, verifies transition evidence, and preserves breached/unresolved/stop-out state", async () => {
  const platformAccountId = "trader-1";
  const perAccountMigrationId = "staging-v2-apply:trader-1";
  const openPositions = [{
    id: "p-1",
    positionId: "p-1",
    symbol: "EURUSD",
    side: "BUY",
    status: "OPEN",
    openVolume: "1",
    entryPrice: "1.1",
    margin: "1100",
    stopLoss: null,
    takeProfit: "1.12",
  }];
  const orders = [{
    id: "o-1",
    orderId: "o-1",
    symbol: "XAUUSD",
    side: "BUY",
    type: "LIMIT",
    status: "PENDING",
    requestedVolume: "0.5",
    limitPrice: "2500",
    stopPrice: null,
    stopLoss: null,
    takeProfit: null,
  }];

  let migrated = false;
  const transitionCalls = [];
  const connector = {
    async adminObservability() {
      if (!migrated) {
        return observability({
          accountType: "CHALLENGE",
          status: "BREACHED",
          tradingEnabled: false,
          riskProcessingState: "RISK_UNRESOLVED",
          riskUnresolvedReason: "RISK_SEQUENCE_GAP",
          marginStopOut: { state: "ACTIVE", episodeId: "stopout-1", levelPercent: "50" },
          openPositions,
          orders,
        });
      }
      return observability({
        version: ACG_FUNDED_RISK_POLICY_V2_VERSION,
        policy: ACG_FUNDED_V2_EXECUTION_POLICY,
        accountType: "CHALLENGE",
        status: "BREACHED",
        tradingEnabled: false,
        riskProcessingState: "RISK_UNRESOLVED",
        riskUnresolvedReason: "RISK_SEQUENCE_GAP",
        marginStopOut: { state: "ACTIVE", episodeId: "stopout-1", levelPercent: "50" },
        policyTransitions: [completedTransition(perAccountMigrationId)],
        openPositions,
        orders,
      });
    },
    async transitionRiskPolicy(command) {
      transitionCalls.push(command);
      migrated = true;
      return {
        operation: "POLICY_TRANSITION",
        idempotentReplay: false,
        transition: completedTransition(perAccountMigrationId),
      };
    },
  };

  const result = await auditAndMigrateFundedRiskPolicyV2({
    accountModel: accountModel([fundedRow({ platformAccountId })]),
    connector,
    apply: true,
    migrationId: "staging-v2-apply",
  });

  assert.equal(transitionCalls.length, 1);
  assert.deepEqual(transitionCalls[0], {
    platformAccountId,
    migrationId: perAccountMigrationId,
    fromVersion: ACG_FUNDED_RISK_POLICY_V1_VERSION,
    toVersion: ACG_FUNDED_RISK_POLICY_V2_VERSION,
    riskPolicy: ACG_FUNDED_V2_TRANSITION_POLICY,
  });

  const record = result.records[0];
  assert.equal(record.action, "MIGRATED");
  assert.equal(record.verified, true);
  assert.equal(record.traderStatus, "BREACHED");
  assert.equal(record.tradingEnabled, false);
  assert.equal(record.snapshot.account.riskProcessingState, "RISK_UNRESOLVED");
  assert.equal(record.snapshot.account.marginStopOut.state, "ACTIVE");
  assert.equal(record.snapshot.openPositions.length, 1);
  assert.equal(record.snapshot.pendingOrders.length, 1);
  assert.equal(record.verification.accountStateUnchanged, true);
  assert.equal(record.verification.positionsUnchanged, true);
  assert.equal(record.verification.pendingOrdersUnchanged, true);
  assert.equal(record.verification.concurrentFinancialChange, false);
  assert.equal(result.summary.accountsMigrated, 1);
  assert.equal(result.summary.accountsVerified, 1);
});

test("rerun after an interrupted migration resumes from durable Trader transition evidence without rewriting policy", async () => {
  const platformAccountId = "trader-1";
  const migrationId = "staging-v2-resume";
  const perAccountMigrationId = `${migrationId}:${platformAccountId}`;
  let transitionCalls = 0;

  const connector = {
    async adminObservability() {
      return observability({
        version: ACG_FUNDED_RISK_POLICY_V2_VERSION,
        policy: ACG_FUNDED_V2_EXECUTION_POLICY,
        policyTransitions: [completedTransition(perAccountMigrationId)],
      });
    },
    async transitionRiskPolicy() {
      transitionCalls += 1;
    },
  };

  const result = await auditAndMigrateFundedRiskPolicyV2({
    accountModel: accountModel([fundedRow({ platformAccountId })]),
    connector,
    apply: true,
    migrationId,
  });

  assert.equal(transitionCalls, 0);
  assert.equal(result.records[0].action, "ALREADY_V2");
  assert.equal(result.records[0].verified, true);
  assert.equal(result.summary.alreadyV2Accounts, 1);
});

test("unknown policy versions are never coerced into V2 and require manual review", async () => {
  let transitionCalls = 0;
  const connector = {
    async adminObservability() {
      return observability({ version: "ACG_FUNDED_LEGACY_UNKNOWN" });
    },
    async transitionRiskPolicy() {
      transitionCalls += 1;
    },
  };

  const result = await auditAndMigrateFundedRiskPolicyV2({
    accountModel: accountModel([fundedRow()]),
    connector,
    apply: true,
    migrationId: "staging-v2-unknown",
  });

  assert.equal(transitionCalls, 0);
  assert.equal(result.records[0].action, "MANUAL_REVIEW");
  assert.equal(result.records[0].ineligibleReason, "SOURCE_POLICY_VERSION_NOT_V1");
  assert.equal(result.summary.accountsNeedingManualReview, 1);
});

test("migration snapshots verify unchanged financial state, positions and pending orders when revision is stable", () => {
  const before = migrationObservationSnapshot(observability({
    openPositions: [{ id: "p-1", positionId: "p-1", status: "OPEN", symbol: "EURUSD", side: "BUY", openVolume: "1", entryPrice: "1.1", margin: "1100" }],
    orders: [{ id: "o-1", orderId: "o-1", status: "PENDING", symbol: "EURUSD", side: "BUY", type: "LIMIT", requestedVolume: "1", limitPrice: "1.09" }],
  }));
  const after = structuredClone(before);

  assert.deepEqual(compareMigrationInvariants(before, after, 7), {
    concurrentFinancialChange: false,
    accountStateUnchanged: true,
    positionsUnchanged: true,
    pendingOrdersUnchanged: true,
  });

  after.account.financialRevision = 8;
  after.account.state.balance = "99900";
  const concurrent = compareMigrationInvariants(before, after, 8);
  assert.equal(concurrent.concurrentFinancialChange, true);
  assert.equal(concurrent.accountStateUnchanged, false);
});

test("default rollout id remains stable for resumable staging runs", () => {
  assert.equal(ACG_FUNDED_V2_MIGRATION_ID, "ACG_FUNDED_V2_ROLLOUT_2026_09");
});
