import test from "node:test";
import assert from "node:assert/strict";
import {
  ACG_FUNDED_EXECUTION_POLICY,
  ACG_FUNDED_RISK_POLICY_VERSION,
} from "../../src/connectors/trading/account-provisioning.js";
import {
  auditAndMigrateFundedRiskPolicyV1,
  collectTraderTargets,
  compareExecutionPolicy,
  needsMigration,
} from "../../src/maintenance/fundedRiskPolicyV1.js";

function accountModel(rows) {
  return {
    find(filter) {
      assert.deepEqual(filter, { platform: "acg-trader" });
      return {
        select(fields) {
          assert.match(fields, /platformAccounts/);
          return this;
        },
        async lean() {
          return rows;
        },
      };
    },
  };
}

function remoteAccount({
  version = ACG_FUNDED_RISK_POLICY_VERSION,
  policy = ACG_FUNDED_EXECUTION_POLICY,
  openPositions = [],
} = {}) {
  return {
    account: {
      status: "ACTIVE",
      riskPolicy: { ...policy },
      challenge: { riskPolicyVersion: version },
    },
    openPositions,
  };
}

test("collectTraderTargets audits every unique platform account, including historical phases", () => {
  const rows = [{
    accountId: "ACG-1",
    status: "FUNDED",
    currentPhase: 2,
    platformAccountId: "master",
    platformAccounts: [
      { platformAccountId: "phase-1", phase: 1, accountType: "CHALLENGE", status: "COMPLETED" },
      { platformAccountId: "phase-2", phase: 2, accountType: "CHALLENGE", status: "COMPLETED" },
      { platformAccountId: "master", phase: 2, accountType: "FUNDED", status: "ACTIVE" },
    ],
  }];

  assert.deepEqual(
    collectTraderTargets(rows).map(row => row.platformAccountId),
    ["phase-1", "phase-2", "master"],
  );
});

test("policy comparison separates missing fields from non-null mismatches", () => {
  const result = compareExecutionPolicy({
    ...ACG_FUNDED_EXECUTION_POLICY,
    maxRiskPerTradePercent: 5,
    maxAggregateRiskPercent: null,
  });

  assert.deepEqual(result.mismatches, [{
    key: "maxRiskPerTradePercent",
    expected: "1",
    actual: "5",
  }]);
  assert.deepEqual(result.missing, [{
    key: "maxAggregateRiskPercent",
    expected: "2",
    actual: null,
  }]);
});

test("read-only audit flags policy drift and open positions without SL without mutating Trader", async () => {
  let syncCalls = 0;
  const connector = {
    async adminObservability() {
      return remoteAccount({
        version: null,
        policy: {
          ...ACG_FUNDED_EXECUTION_POLICY,
          maxRiskPerTradePercent: "7",
          maxAggregateRiskPercent: null,
        },
        openPositions: [
          { positionId: "p-1", symbol: "BTCUSD", side: "SELL", openVolume: "5", stopLoss: null },
          { positionId: "p-2", symbol: "EURUSD", side: "BUY", openVolume: "1", stopLoss: "1.09" },
        ],
      });
    },
    async syncChallenge() {
      syncCalls += 1;
    },
  };

  const result = await auditAndMigrateFundedRiskPolicyV1({
    accountModel: accountModel([{
      accountId: "ACG-1",
      status: "ACTIVE",
      currentPhase: 1,
      platformAccountId: "trader-1",
      platformAccounts: [{ platformAccountId: "trader-1", phase: 1, accountType: "CHALLENGE", status: "ACTIVE" }],
    }]),
    connector,
    apply: false,
  });

  assert.equal(syncCalls, 0);
  assert.equal(result.summary.tradingAccountsAudited, 1);
  assert.equal(result.summary.accountsWithMissingPolicyFieldsBefore, 1);
  assert.equal(result.summary.accountsWithNonNullPolicyMismatchBefore, 1);
  assert.equal(result.summary.accountsWithOpenPositionsWithoutStopLoss, 1);
  assert.equal(result.summary.openPositionsWithoutStopLoss, 1);
  assert.equal(needsMigration(result.records[0]), true);
});

test("apply mode pushes the Funded V1 contract and verifies the persisted Trader state", async () => {
  let migrated = false;
  const syncCalls = [];
  const connector = {
    async adminObservability() {
      if (!migrated) {
        return remoteAccount({
          version: null,
          policy: {
            ...ACG_FUNDED_EXECUTION_POLICY,
            maxMarginUsagePercent: "75",
          },
        });
      }
      return remoteAccount();
    },
    async syncChallenge(command) {
      syncCalls.push(command);
      migrated = true;
    },
  };

  const result = await auditAndMigrateFundedRiskPolicyV1({
    accountModel: accountModel([{
      accountId: "ACG-1",
      status: "ACTIVE",
      currentPhase: 1,
      platformAccountId: "trader-1",
      platformAccounts: [{ platformAccountId: "trader-1", phase: 1, accountType: "CHALLENGE", status: "ACTIVE" }],
    }]),
    connector,
    apply: true,
  });

  assert.equal(syncCalls.length, 1);
  assert.deepEqual(syncCalls[0].riskPolicy, ACG_FUNDED_EXECUTION_POLICY);
  assert.equal(syncCalls[0].riskPolicyVersion, ACG_FUNDED_RISK_POLICY_VERSION);
  assert.equal(result.summary.accountsMigrated, 1);
  assert.equal(result.summary.accountsWithPolicyMismatchAfter, 0);
  assert.equal(result.summary.accountsWithVersionMismatchAfter, 0);
});
