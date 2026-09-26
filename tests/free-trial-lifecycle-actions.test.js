import test from "node:test";
import assert from "node:assert/strict";

import { cancelDemoAccount } from "../src/apis/services/customer.service.js";
import { LifecycleReconciliationWorker } from "../src/workers/lifecycle-reconciliation.worker.js";

function demoAccount(overrides = {}) {
  return {
    _id: "mongo-trial-1",
    accountId: "TRIAL-1",
    customerId: "CUS-1",
    ownerExternalRef: "CUS-1",
    accountMode: "DEMO",
    challengeType: "ONE_STEP",
    accountSize: 100000,
    currentPhase: 1,
    status: "ACTIVE",
    enabled: true,
    activeTrialKey: "CUS-1",
    commandPending: null,
    platform: "acg-trader",
    platformAccountId: "platform-1",
    platformAccounts: [{
      phase: 1,
      accountType: "DEMO",
      externalRef: "TRIAL-1:phase:1",
      platformAccountId: "platform-1",
      status: "ACTIVE",
    }],
    trial: {
      startedAt: new Date("2026-09-01T00:00:00.000Z"),
      expiresAt: new Date("2026-09-15T00:00:00.000Z"),
      completedAt: null,
      cancelledAt: null,
      result: null,
    },
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    async save() {},
    ...overrides,
  };
}

test("customer cancellation atomically closes the trial slot and remote account", async () => {
  const account = demoAccount();
  const closeCalls = [];
  const analytics = [];
  let appliedUpdate;

  const accountModel = {
    async findOne() {
      return account;
    },
    async findOneAndUpdate(_filter, update) {
      appliedUpdate = update.$set;
      Object.assign(account, update.$set);
      return account;
    },
  };

  const result = await cancelDemoAccount(
    { id: "auth-1", email: "trader@example.com", customerId: "CUS-1", customerIds: ["CUS-1"] },
    "TRIAL-1",
    {
      accountModel,
      connectorResolver: () => ({
        async closeAccount(input) {
          closeCalls.push(input);
        },
      }),
      analyticsRecorder: async event => {
        analytics.push(event);
      },
      now: () => new Date("2026-09-05T12:00:00.000Z"),
    },
  );

  assert.equal(appliedUpdate.status, "CLOSED");
  assert.equal(appliedUpdate.enabled, false);
  assert.equal(appliedUpdate.activeTrialKey, null);
  assert.equal(appliedUpdate.commandPending, null);
  assert.equal(appliedUpdate.trial.result, "CANCELLED");
  assert.equal(appliedUpdate.trial.cancelledAt.toISOString(), "2026-09-05T12:00:00.000Z");
  assert.equal(closeCalls.length, 1);
  assert.equal(closeCalls[0].platformAccountId, "platform-1");
  assert.equal(closeCalls[0].liquidate, true);
  assert.equal(account.platformAccounts[0].status, "CLOSED");
  assert.equal(analytics[0].event, "trial_cancelled");
  assert.equal(result.status, "CLOSED");
  assert.equal(result.trial.result, "CANCELLED");
});

test("reconciliation expires due trials, releases the slot, and closes Trader", async () => {
  const now = new Date("2026-09-16T00:00:00.000Z");
  const account = demoAccount();
  const closeCalls = [];
  const analytics = [];
  let findQuery;
  let appliedUpdate;

  const accountModel = {
    find(query) {
      findQuery = query;
      return {
        async limit() {
          return [account];
        },
      };
    },
    async findOneAndUpdate(_filter, update) {
      appliedUpdate = update.$set;
      Object.assign(account, update.$set);
      return account;
    },
  };

  const worker = new LifecycleReconciliationWorker({
    accountModel,
    now: () => now,
    connectorResolver: () => ({
      async closeAccount(input) {
        closeCalls.push(input);
      },
    }),
    analyticsRecorder: async event => {
      analytics.push(event);
    },
  });

  await worker.expireDueTrials();

  assert.equal(findQuery.accountMode, "DEMO");
  assert.deepEqual(findQuery.status.$in, ["NEW", "ACTIVE", "PHASE_2"]);
  assert.equal(appliedUpdate.status, "EXPIRED");
  assert.equal(appliedUpdate.enabled, false);
  assert.equal(appliedUpdate.activeTrialKey, null);
  assert.equal(appliedUpdate.commandPending, null);
  assert.equal(appliedUpdate.trial.result, "EXPIRED");
  assert.equal(appliedUpdate.trial.completedAt.toISOString(), now.toISOString());
  assert.equal(closeCalls.length, 1);
  assert.equal(closeCalls[0].platformAccountId, "platform-1");
  assert.equal(closeCalls[0].liquidate, true);
  assert.equal(account.platformAccounts[0].status, "CLOSED");
  assert.equal(analytics[0].event, "trial_expired");
});

test("expiry remains terminal when remote shutdown needs a retry", async () => {
  const account = demoAccount();
  let appliedUpdate;

  const accountModel = {
    find() {
      return {
        async limit() {
          return [account];
        },
      };
    },
    async findOneAndUpdate(_filter, update) {
      appliedUpdate = update.$set;
      Object.assign(account, update.$set);
      return account;
    },
  };

  const worker = new LifecycleReconciliationWorker({
    accountModel,
    now: () => new Date("2026-09-16T00:00:00.000Z"),
    connectorResolver: () => ({
      async closeAccount() {
        throw new Error("temporary provider outage");
      },
    }),
    analyticsRecorder: async () => {},
  });

  await worker.expireDueTrials();

  assert.equal(appliedUpdate.status, "EXPIRED");
  assert.equal(appliedUpdate.activeTrialKey, null);
  assert.equal(account.platformAccounts[0].status, "ACTIVE");
});
