import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPayoutApprovalEligible,
  serializeAdminPayout,
  transitionAdminPayout,
} from "../src/apis/services/payoutAdmin.service.js";

function payout(overrides = {}) {
  return {
    payoutId: "PAYOUT-001",
    customerId: "CUS-001",
    accountId: "MASTER-001",
    activeKey: "MASTER-001",
    status: "REQUESTED",
    requestedAmountUsd: 400,
    method: "UPI",
    settlementCurrency: "INR",
    settlementAmount: 33200,
    destination: {
      method: "UPI",
      label: "UPI",
      destination: "tr***@upi",
    },
    cycle: { key: "ON_DEMAND", frequency: "On Demand" },
    snapshot: {
      realizedProfitUsd: 500,
      profitSplitPercent: 80,
      entitlementUsd: 400,
      previouslyPaidUsd: 0,
      previouslyReservedUsd: 0,
      availableBeforeRequestUsd: 400,
    },
    ...overrides,
  };
}

function transitionModel(initial) {
  let record = { ...initial };

  return {
    get record() { return record; },
    async findOne(query) {
      return query.payoutId === record.payoutId ? { ...record } : null;
    },
    async findOneAndUpdate(filter, update) {
      if (filter.payoutId !== record.payoutId) return null;
      const allowed = filter.status?.$in || [];
      if (!allowed.includes(record.status)) return null;
      record = { ...record, ...(update.$set || {}) };
      return { ...record };
    },
  };
}

test("payout review lifecycle progresses forward and clears active reservation when paid", async () => {
  const model = transitionModel(payout());
  let clock = 0;
  const now = () => new Date(Date.UTC(2026, 9, 1, 10, clock++, 0));
  const deps = { payoutModel: model, now, approvalGuard: async () => ({}) };

  let result = await transitionAdminPayout("PAYOUT-001", {
    action: "START_REVIEW",
    reason: "Destination verified",
  }, deps);
  assert.equal(result.after.status, "REVIEWING");

  result = await transitionAdminPayout("PAYOUT-001", {
    action: "APPROVE",
    reason: "Eligibility and destination approved",
  }, deps);
  assert.equal(result.after.status, "APPROVED");

  result = await transitionAdminPayout("PAYOUT-001", {
    action: "MARK_PROCESSING",
    reason: "Submitted to payout operations",
    provider: "manual-test",
  }, deps);
  assert.equal(result.after.status, "PROCESSING");

  result = await transitionAdminPayout("PAYOUT-001", {
    action: "MARK_SENT",
    reason: "UPI transfer sent",
    utr: "UTR-001",
  }, deps);
  assert.equal(result.after.status, "SENT");
  assert.equal(result.after.utr, "UTR-001");

  result = await transitionAdminPayout("PAYOUT-001", {
    action: "MARK_PAID",
    reason: "Settlement confirmed",
    traderReceivedAmount: 33200,
    providerFeePaidByAcg: 30,
  }, deps);
  assert.equal(result.after.status, "PAID");
  assert.equal(result.after.traderReceivedAmount, 33200);
  assert.equal(result.after.providerFeePaidByAcg, 30);
  assert.equal(result.after.acgTotalCostAmount, 33230);
  assert.equal(result.after.accountingCurrency, "INR");
  assert.equal(result.after.accountingSource, "ADMIN_VERIFIED");
  assert.equal(model.record.activeKey, null);
  assert.ok(result.after.paidAt);
});

test("MARK_PAID is blocked if the trader received less than the quoted amount", async () => {
  const model = transitionModel(payout({ status: "SENT", utr: "UTR-001" }));

  await assert.rejects(
    () => transitionAdminPayout("PAYOUT-001", {
      action: "MARK_PAID",
      reason: "Provider deducted its fee",
      traderReceivedAmount: 33170,
      providerFeePaidByAcg: 30,
    }, { payoutModel: model }),
    error => error?.code === "PAYOUT_EXACT_RECEIPT_MISMATCH"
      && error?.expectedAmount === 33200
      && error?.receivedAmount === 33170,
  );

  assert.equal(model.record.status, "SENT");
  assert.equal(model.record.activeKey, "MASTER-001");
});

test("MARK_PAID requires ACG provider fee accounting even when the fee is zero", async () => {
  const model = transitionModel(payout({ status: "SENT", utr: "UTR-001" }));

  await assert.rejects(
    () => transitionAdminPayout("PAYOUT-001", {
      action: "MARK_PAID",
      reason: "Settlement confirmed",
      traderReceivedAmount: 33200,
    }, { payoutModel: model }),
    error => error?.code === "PAYOUT_PROVIDER_FEE_REQUIRED",
  );

  const result = await transitionAdminPayout("PAYOUT-001", {
    action: "MARK_PAID",
    reason: "Settlement confirmed with no provider fee",
    traderReceivedAmount: 33200,
    providerFeePaidByAcg: 0,
  }, { payoutModel: model });

  assert.equal(result.after.status, "PAID");
  assert.equal(result.after.providerFeePaidByAcg, 0);
  assert.equal(result.after.acgTotalCostAmount, 33200);
});

test("invalid payout status regressions are rejected", async () => {
  const model = transitionModel(payout({ status: "APPROVED" }));

  await assert.rejects(
    () => transitionAdminPayout("PAYOUT-001", {
      action: "START_REVIEW",
      reason: "Try to move backwards",
    }, { payoutModel: model }),
    error => error?.code === "INVALID_PAYOUT_STATUS_TRANSITION",
  );
});

test("fiat payout cannot be marked sent without a transfer reference", async () => {
  const model = transitionModel(payout({ status: "PROCESSING" }));

  await assert.rejects(
    () => transitionAdminPayout("PAYOUT-001", {
      action: "MARK_SENT",
      reason: "Sent",
    }, { payoutModel: model }),
    error => error?.code === "PAYOUT_TRANSFER_REFERENCE_REQUIRED",
  );
});

test("USDT payout requires a transaction hash before SENT", async () => {
  const model = transitionModel(payout({
    status: "PROCESSING",
    method: "USDT",
    settlementCurrency: "USDT",
    settlementAmount: 399.5,
    destination: {
      method: "USDT",
      label: "USDT · TRC20",
      destination: "TQn9Y2…bLSE",
      network: "TRC20",
    },
  }));

  await assert.rejects(
    () => transitionAdminPayout("PAYOUT-001", {
      action: "MARK_SENT",
      reason: "Crypto submitted",
    }, { payoutModel: model }),
    error => error?.code === "PAYOUT_TX_HASH_REQUIRED",
  );

  const result = await transitionAdminPayout("PAYOUT-001", {
    action: "MARK_SENT",
    reason: "Crypto submitted",
    txHash: "abc123",
    network: "TRC20",
  }, { payoutModel: model });

  assert.equal(result.after.status, "SENT");
  assert.equal(result.after.txHash, "abc123");
  assert.equal(result.after.network, "TRC20");
});

test("rejecting a payout frees the account reservation and records the reason", async () => {
  const model = transitionModel(payout({ status: "REVIEWING" }));

  const result = await transitionAdminPayout("PAYOUT-001", {
    action: "REJECT",
    reason: "Destination name does not match verified account holder",
  }, { payoutModel: model });

  assert.equal(result.after.status, "REJECTED");
  assert.equal(model.record.activeKey, null);
  assert.equal(result.after.failure.code, "ADMIN_REJECTED");
  assert.match(result.after.failure.message, /Destination name/);
});

test("approval guard rejects a payout if realized Master profit fell below the requested amount", async () => {
  const record = payout({
    status: "REVIEWING",
    requestedAmountUsd: 400,
    snapshot: {
      realizedProfitUsd: 500,
      profitSplitPercent: 80,
      entitlementUsd: 400,
      previouslyPaidUsd: 0,
      previouslyReservedUsd: 0,
      availableBeforeRequestUsd: 400,
    },
  });
  const accountModel = {
    async findOne() {
      return {
        accountId: "MASTER-001",
        status: "FUNDED",
        enabled: true,
        customerAccessBlocked: false,
        projections: { profit: 300 },
        commercialTerms: { profitSplit: 80 },
      };
    },
  };
  const payoutModel = {
    find() {
      return { lean: async () => [] };
    },
  };

  await assert.rejects(
    () => assertPayoutApprovalEligible(record, { accountModel, payoutModel }),
    error => error?.code === "PAYOUT_APPROVAL_FUNDS_CHANGED"
      && error?.availableUsd === 240
      && error?.requestedUsd === 400,
  );
});

test("approval guard allows the snapshotted request when current realized entitlement still covers it", async () => {
  const record = payout({
    status: "REVIEWING",
    requestedAmountUsd: 400,
    snapshot: {
      realizedProfitUsd: 500,
      profitSplitPercent: 80,
      entitlementUsd: 400,
      previouslyPaidUsd: 0,
      previouslyReservedUsd: 0,
      availableBeforeRequestUsd: 400,
    },
  });
  const accountModel = {
    async findOne() {
      return {
        accountId: "MASTER-001",
        status: "FUNDED",
        enabled: true,
        customerAccessBlocked: false,
        projections: { profit: 1000 },
        commercialTerms: { profitSplit: 80 },
      };
    },
  };
  const payoutModel = {
    find() {
      return { lean: async () => [{ requestedAmountUsd: 100, status: "PAID" }] };
    },
  };

  const result = await assertPayoutApprovalEligible(record, { accountModel, payoutModel });
  assert.equal(result.entitlementUsd, 800);
  assert.equal(result.alreadyPaidUsd, 100);
  assert.equal(result.availableForApprovalUsd, 700);
});

test("admin payout serializer never exposes encrypted destination material", () => {
  const serialized = serializeAdminPayout(payout({
    destinationEncrypted: "secret-ciphertext",
    destinationIv: "secret-iv",
    destinationAuthTag: "secret-tag",
  }));

  assert.equal(serialized.destination.destination, "tr***@upi");
  assert.equal(serialized.destinationEncrypted, undefined);
  assert.equal(serialized.destinationIv, undefined);
  assert.equal(serialized.destinationAuthTag, undefined);
});
