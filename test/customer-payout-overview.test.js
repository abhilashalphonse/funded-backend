import test from "node:test";
import assert from "node:assert/strict";
import PayoutRequest from "../src/models/payoutRequest.model.js";
import {
  PAYOUT_METHODS,
  buildPayoutCycle,
  buildPayoutOverview,
  getCustomerPayoutHistory,
  getCustomerPayoutOverview,
} from "../src/apis/services/payout.service.js";

const baseAccount = {
  accountId: "CHALLENGE-001",
  accountMode: "CHALLENGE",
  status: "ACTIVE",
  enabled: true,
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

function masterAccount(overrides = {}) {
  return {
    ...baseAccount,
    accountId: "MASTER-001",
    status: "FUNDED",
    fundedApprovedAt: new Date("2026-10-01T10:00:00.000Z"),
    ...overrides,
  };
}

function payoutModelWith(records = []) {
  return {
    find() {
      return {
        sort() { return this; },
        limit() { return this; },
        lean() { return Promise.resolve(records); },
      };
    },
  };
}

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
  assert.equal(overview.fees.providerFeePolicy, "ACG_COVERS");
  assert.equal(overview.fees.traderPaysProviderFee, false);
  assert.ok(overview.eligibility.blockers.includes("MASTER_ACCOUNT_REQUIRED"));
});

test("trial without commercial terms uses a clearly illustrative 80 percent preview split", () => {
  const overview = buildPayoutOverview({
    ...baseAccount,
    accountMode: "DEMO",
    status: "ACTIVE",
    commercialTerms: undefined,
    projections: { profit: 1000 },
  });

  assert.equal(overview.commercialTerms.profitSplitPercent, 80);
  assert.equal(overview.commercialTerms.profitSplitSource, "ILLUSTRATIVE_DEFAULT");
  assert.equal(overview.performance.estimatedTraderShareUsd, 800);
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

test("weekly payout eligibility starts seven days after Master activation", () => {
  const account = masterAccount({
    commercialTerms: { profitSplit: 80, payoutFrequency: "Weekly" },
  });

  const before = buildPayoutOverview(account, [], new Date("2026-10-08T09:59:59.999Z"));
  assert.equal(before.eligibility.canRequest, false);
  assert.ok(before.eligibility.blockers.includes("PAYOUT_CYCLE_NOT_REACHED"));
  assert.equal(before.cycle.nextEligibleAt.toISOString(), "2026-10-08T10:00:00.000Z");

  const atBoundary = buildPayoutOverview(account, [], new Date("2026-10-08T10:00:00.000Z"));
  assert.equal(atBoundary.eligibility.canRequest, true);
  assert.equal(atBoundary.cycle.currentCycleKey, "WEEKLY:1");
  assert.equal(atBoundary.ledger.availableUsd, 4000);
});

test("biweekly payout eligibility starts fourteen days after Master activation", () => {
  const account = masterAccount();
  const cycle = buildPayoutCycle(account, new Date("2026-10-15T10:00:00.000Z"));

  assert.equal(cycle.reached, true);
  assert.equal(cycle.currentCycleKey, "BIWEEKLY:1");
  assert.equal(cycle.currentCycleEligibleAt.toISOString(), "2026-10-15T10:00:00.000Z");
  assert.equal(cycle.nextCycleAt.toISOString(), "2026-10-29T10:00:00.000Z");
});

test("monthly payout cycles preserve activation day and clamp month ends", () => {
  const account = masterAccount({
    fundedApprovedAt: new Date("2027-01-31T10:00:00.000Z"),
    commercialTerms: { profitSplit: 80, payoutFrequency: "Monthly" },
  });
  const cycle = buildPayoutCycle(account, new Date("2027-02-28T10:00:00.000Z"));

  assert.equal(cycle.reached, true);
  assert.equal(cycle.currentCycleKey, "MONTHLY:1");
  assert.equal(cycle.currentCycleEligibleAt.toISOString(), "2027-02-28T10:00:00.000Z");
  assert.equal(cycle.nextCycleAt.toISOString(), "2027-03-31T10:00:00.000Z");
});

test("on-demand Master account is eligible immediately after activation when profit exists", () => {
  const account = masterAccount({
    commercialTerms: { profitSplit: 80, payoutFrequency: "On Demand" },
  });
  const overview = buildPayoutOverview(account, [], new Date("2026-10-01T10:00:00.000Z"));

  assert.equal(overview.cycle.currentCycleKey, "ON_DEMAND");
  assert.equal(overview.eligibility.canRequest, true);
  assert.equal(overview.ledger.availableUsd, 4000);
});

test("paid and active payouts are deducted from currently available entitlement", () => {
  const account = masterAccount({
    commercialTerms: { profitSplit: 80, payoutFrequency: "On Demand" },
    projections: { profit: 10000 },
  });
  const records = [
    { payoutId: "P-2", status: "PROCESSING", requestedAmountUsd: 1000, createdAt: new Date("2026-10-04T00:00:00Z") },
    { payoutId: "P-1", status: "PAID", requestedAmountUsd: 2500, paidAt: new Date("2026-10-03T00:00:00Z") },
  ];
  const overview = buildPayoutOverview(account, records, new Date("2026-10-05T00:00:00Z"));

  assert.equal(overview.performance.estimatedTraderShareUsd, 8000);
  assert.equal(overview.ledger.lifetimePaidUsd, 2500);
  assert.equal(overview.ledger.activeReservedUsd, 1000);
  assert.equal(overview.ledger.availableUsd, 4500);
  assert.equal(overview.eligibility.canRequest, false);
  assert.ok(overview.eligibility.blockers.includes("PAYOUT_ALREADY_IN_PROGRESS"));
});

test("a paid payout consumes the current fixed payout cycle", () => {
  const account = masterAccount({
    commercialTerms: { profitSplit: 80, payoutFrequency: "Weekly" },
    projections: { profit: 7500 },
  });
  const records = [{
    payoutId: "P-1",
    status: "PAID",
    requestedAmountUsd: 2000,
    cycle: { key: "WEEKLY:1" },
    paidAt: new Date("2026-10-08T12:00:00Z"),
  }];
  const overview = buildPayoutOverview(account, records, new Date("2026-10-09T10:00:00Z"));

  assert.equal(overview.ledger.availableUsd, 4000);
  assert.equal(overview.eligibility.canRequest, false);
  assert.ok(overview.eligibility.blockers.includes("PAYOUT_CYCLE_ALREADY_USED"));
  assert.equal(overview.cycle.nextEligibleAt.toISOString(), "2026-10-15T10:00:00.000Z");
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

test("UPI payout method does not expose undocumented fixed provider limits", () => {
  const upi = PAYOUT_METHODS.find(method => method.id === "UPI");

  assert.equal(upi?.limits, null);
});

test("payout ledger schema enforces one active payout and idempotency uniqueness", () => {
  const indexes = PayoutRequest.schema.indexes();
  const active = indexes.find(([, options]) => options?.name === "unique_active_payout_per_account");
  const idempotency = indexes.find(([, options]) => options?.name === "unique_customer_payout_idempotency");

  assert.deepEqual(active?.[0], { activeKey: 1 });
  assert.equal(active?.[1]?.unique, true);
  assert.deepEqual(active?.[1]?.partialFilterExpression, { activeKey: { $type: "string" } });

  assert.deepEqual(idempotency?.[0], { customerId: 1, idempotencyKey: 1 });
  assert.equal(idempotency?.[1]?.unique, true);
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

  const overview = await getCustomerPayoutOverview(customer, "CHALLENGE-001", {
    accountModel,
    payoutModel: payoutModelWith([]),
  });

  assert.equal(capturedQuery.accountId, "CHALLENGE-001");
  assert.ok(Array.isArray(capturedQuery.$or));
  assert.equal(overview.accountId, "CHALLENGE-001");
});

test("customer payout history returns only customer-safe ledger fields", async () => {
  const accountModel = {
    async findOne() {
      return { ...masterAccount() };
    },
  };
  const records = [{
    payoutId: "PAYOUT-001",
    accountId: "MASTER-001",
    customerId: "customer-1",
    status: "PAID",
    requestedAmountUsd: 4000,
    method: "USDT",
    settlementCurrency: "USDT",
    settlementAmount: 3999,
    destinationSnapshot: { wallet: "SECRET-WALLET" },
    providerReference: "SECRET-PROVIDER-REF",
    txHash: "SECRET-TX",
    cycle: { key: "BIWEEKLY:1", frequency: "Biweekly", eligibleAt: new Date("2026-10-15T10:00:00Z") },
    requestedAt: new Date("2026-10-15T10:05:00Z"),
    paidAt: new Date("2026-10-15T11:00:00Z"),
  }];

  const history = await getCustomerPayoutHistory(
    { customerId: "customer-1" },
    "MASTER-001",
    { accountModel, payoutModel: payoutModelWith(records) },
  );

  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].payoutId, "PAYOUT-001");
  assert.equal(history.items[0].requestedAmountUsd, 4000);
  assert.equal(history.items[0].destinationSnapshot, undefined);
  assert.equal(history.items[0].providerReference, undefined);
  assert.equal(history.items[0].txHash, undefined);
});

test("customer payout overview returns not found for an unowned account", async () => {
  const accountModel = { async findOne() { return null; } };

  await assert.rejects(
    () => getCustomerPayoutOverview(
      { id: "auth-user-1", customerId: "customer-1", email: "trader@example.com" },
      "OTHER-ACCOUNT",
      { accountModel, payoutModel: payoutModelWith([]) },
    ),
    error => error?.status === 404 && error?.code === "PAYOUT_ACCOUNT_NOT_FOUND",
  );
});
