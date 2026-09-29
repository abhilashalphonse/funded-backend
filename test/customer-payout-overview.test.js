import test from "node:test";
import assert from "node:assert/strict";
import {
  PAYOUT_METHODS,
  buildPayoutOverview,
  getCustomerPayoutOverview,
} from "../src/apis/services/payout.service.js";

const baseAccount = {
  accountId: "CHALLENGE-001",
  accountMode: "CHALLENGE",
  status: "ACTIVE",
  initialDeposit: 100000,
  accountSize: 100000,
  balance: 105000,
  projections: { profit: 5000 },
  commercialTerms: {
    profitSplit: 80,
    payoutFrequency: "Biweekly",
  },
  lastPlatformSnapshotAt: new Date("2026-09-29T12:00:00.000Z"),
};

test("trial payout overview is preview-only and uses realized profit projection", () => {
  const overview = buildPayoutOverview({
    ...baseAccount,
    accountMode: "DEMO",
    status: "ACTIVE",
    projections: { profit: 3420.125 },
  });

  assert.equal(overview.accountStage, "TRIAL");
  assert.equal(overview.mode, "PREVIEW");
  assert.equal(overview.performance.realizedProfitUsd, 3420.13);
  assert.equal(overview.performance.estimatedTraderShareUsd, 2736.1);
  assert.equal(overview.eligibility.canRequest, false);
  assert.ok(overview.eligibility.blockers.includes("MASTER_ACCOUNT_REQUIRED"));
});

test("challenge payout overview is a journey and never marks evaluation profit withdrawable", () => {
  const overview = buildPayoutOverview(baseAccount);

  assert.equal(overview.accountStage, "CHALLENGE");
  assert.equal(overview.mode, "JOURNEY");
  assert.equal(overview.performance.realizedProfitUsd, 5000);
  assert.equal(overview.performance.estimatedTraderShareUsd, 4000);
  assert.equal(overview.eligibility.canRequest, false);
  assert.ok(overview.eligibility.blockers.includes("MASTER_ACCOUNT_REQUIRED"));
});

test("master payout overview exposes real mode but does not enable requests before request engine exists", () => {
  const overview = buildPayoutOverview({
    ...baseAccount,
    status: "FUNDED",
  });

  assert.equal(overview.accountStage, "MASTER");
  assert.equal(overview.mode, "REAL");
  assert.equal(overview.performance.estimatedTraderShareUsd, 4000);
  assert.equal(overview.eligibility.canRequest, false);
  assert.deepEqual(overview.eligibility.blockers, ["PAYOUT_REQUEST_FLOW_NOT_ENABLED"]);
});

test("negative realized performance never creates a positive payout preview", () => {
  const overview = buildPayoutOverview({
    ...baseAccount,
    projections: { profit: -250.55 },
  });

  assert.equal(overview.performance.realizedProfitUsd, 0);
  assert.equal(overview.performance.estimatedTraderShareUsd, 0);
  assert.ok(overview.eligibility.blockers.includes("NO_REALIZED_PROFIT"));
});

test("UPI payout method exposes the configured INR payout limits", () => {
  const upi = PAYOUT_METHODS.find(method => method.id === "UPI");

  assert.deepEqual(upi?.limits, {
    min: 100,
    max: 20000,
    unit: "INR",
  });
});

test("customer payout overview verifies account ownership before returning financial data", async () => {
  let capturedQuery = null;
  const customer = {
    id: "auth-user-1",
    customerId: "customer-1",
    customerIds: ["customer-legacy"],
    email: "trader@example.com",
  };
  const accountModel = {
    async findOne(query) {
      capturedQuery = query;
      return { ...baseAccount };
    },
  };

  const overview = await getCustomerPayoutOverview(customer, "CHALLENGE-001", { accountModel });

  assert.equal(capturedQuery.accountId, "CHALLENGE-001");
  assert.ok(Array.isArray(capturedQuery.$or));
  assert.equal(overview.accountId, "CHALLENGE-001");
});

test("customer payout overview returns not found for an unowned account", async () => {
  const accountModel = { async findOne() { return null; } };

  await assert.rejects(
    () => getCustomerPayoutOverview(
      { id: "auth-user-1", customerId: "customer-1", email: "trader@example.com" },
      "OTHER-ACCOUNT",
      { accountModel },
    ),
    error => error?.status === 404 && error?.code === "PAYOUT_ACCOUNT_NOT_FOUND",
  );
});
