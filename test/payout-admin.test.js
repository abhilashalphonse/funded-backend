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
    find() { return { lean: async () => [] }; },
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

test("locked payout settlement cannot be changed by an admin action", async () => {
  const model = transitionModel(payout({
    status: "PROCESSING",
    quoteStatus: "LOCKED",
    settlementCurrency: "INR",
    settlementAmount: 33200,
  }));

  await assert.rejects(
    () => transitionAdminPayout("PAYOUT-001", {
      action: "MARK_SENT",
      reason: "Attempt to alter quoted settlement",
      utr: "UTR-001",
      settlementAmount: 33170,
    }, { payoutModel: model }),
    error => error?.code === "PAYOUT_SETTLEMENT_IMMUTABLE",
  );

  assert.equal(model.record.settlementAmount, 33200);
  assert.equal(model.record.status, "PROCESSING");
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
  }, { payoutModel: model,
    accountModel: { async findOne() { return { platform: "simulator" }; } },
  });

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


test("ACG Trader payout approval reserves the exact USD entitlement before Funded status changes", async () => {
  const record = payout({ status: "REVIEWING", requestedAmountUsd: 400 });
  const accountModel = {
    async findOne() {
      return {
        accountId: "MASTER-001",
        platform: "acg-trader",
        platformAccountId: "507f1f77bcf86cd799439011",
        status: "FUNDED",
        enabled: true,
        customerAccessBlocked: false,
        commercialTerms: { profitSplit: 80 },
        platformFinancial: {
          contractVersion: 1,
          accountCurrency: "USD",
          financialRevision: 12,
          initialBalance: "10000",
          balance: "10500",
        },
      };
    },
  };
  const traderClient = {
    async reservePayout(id, command) {
      assert.equal(id, "507f1f77bcf86cd799439011");
      assert.equal(command.payoutId, "PAYOUT-001");
      assert.equal(command.amountUsd, "400");
      assert.equal(command.financialRevision, 12);
      return { reservation: {
        contractVersion: "ACG_PAYOUT_RESERVATION_V1",
        payoutId: "PAYOUT-001",
        platformAccountId: id,
        status: "RESERVED",
        amountUsd: "400",
        financialRevision: 12,
        checkpointHash: "b".repeat(64),
        reservedAt: "2026-10-08T09:00:05.000Z",
      } };
    },
    async getPayoutSettlementCheckpoint(id) {
      assert.equal(id, "507f1f77bcf86cd799439011");
      return { checkpoint: {
        contractVersion: "ACG_PAYOUT_SETTLEMENT_CHECKPOINT_V1",
        platformAccountId: id,
        accountCurrency: "USD",
        financialRevision: 12,
        balance: "10500",
        initialBalance: "10000",
        equity: "10500",
        floatingPnl: "0",
        usedMargin: "0",
        openPositionCount: 0,
        activeOrderCount: 0,
        ledgerEntryId: "ledger-1",
        ledgerBalanceAfter: "10500",
        checkedAt: "2026-10-08T09:00:00.000Z",
        blockers: [],
        settled: true,
        productionPayoutAuthorized: false,
        evidenceHash: "b".repeat(64),
      } };
    },
  };
  const payoutModel = {
    find: () => ({ lean: async () => [] }),
    async findOneAndUpdate(filter, update) {
      assert.equal(filter.payoutId, "PAYOUT-001");
      assert.equal(update.$set.requiresTraderSettlement, true);
      return { ...record, ...update.$set };
    },
  };
  const approved = await assertPayoutApprovalEligible(record, {
    accountModel,
    payoutModel,
    traderClient,
    now: () => new Date("2026-10-08T09:00:05.000Z"),
  });
  assert.equal(approved.traderReservation.status, "RESERVED");
  assert.equal(approved.traderReservation.amountUsd, "400");
  assert.equal(approved.availableForApprovalUsd, 400);
});


test("rejecting a Trader payout claims a nonpayable state before creating its cancellation tombstone", async () => {
  const model = transitionModel(payout({
    status: "REVIEWING", requiresTraderSettlement: true,
  }));
  const result = await transitionAdminPayout("PAYOUT-001", {
    action: "REJECT", reason: "Customer requested cancellation",
  }, {
    payoutModel: model,
    accountModel: { async findOne() {
      return { platform: "acg-trader", platformAccountId: "507f1f77bcf86cd799439011" };
    } },
    traderClient: { async releasePayout(_accountId, id, reason) {
      assert.equal(model.record.status, "REJECTING");
      assert.equal(id, "PAYOUT-001");
      assert.equal(reason, "ADMIN_REJECTED");
      return { reservation: {
        contractVersion: "ACG_PAYOUT_RESERVATION_V1",
        platformAccountId: "507f1f77bcf86cd799439011",
        payoutId: id, status: "CANCELLED",
      } };
    } },
  });
  assert.equal(result.after.status, "REJECTED");
  assert.equal(result.after.traderReservation.status, "CANCELLED");
  assert.equal(model.record.activeKey, null);
});

test("Trader cancellation outage keeps Funded REJECTING and reserved until recovery", async () => {
  const model = transitionModel(payout({
    status: "REVIEWING", requiresTraderSettlement: true,
  }));
  const accountModel = { async findOne() {
    return { platform: "acg-trader", platformAccountId: "507f1f77bcf86cd799439011" };
  } };
  await assert.rejects(
    () => transitionAdminPayout("PAYOUT-001", {
      action: "REJECT", reason: "Verified cancellation",
    }, {
      payoutModel: model, accountModel,
      traderClient: { async releasePayout() { throw new Error("network unavailable"); } },
    }),
    error => error.code === "PAYOUT_TRADER_CANCELLATION_UNCONFIRMED",
  );
  assert.equal(model.record.status, "REJECTING");
  assert.equal(model.record.activeKey, "MASTER-001");
  const resumed = await transitionAdminPayout("PAYOUT-001", {
    action: "REJECT", reason: "Retry verified cancellation",
  }, {
    payoutModel: model, accountModel,
    traderClient: { async releasePayout(id, payoutId) {
      return { reservation: {
        platformAccountId: id, payoutId,
        status: "CANCELLED",
      } };
    } },
  });
  assert.equal(resumed.after.status, "REJECTED");
  assert.equal(model.record.activeKey, null);
});


function legacyTraderAccount() {
  return {
    accountId: 'MASTER-001', platform: 'acg-trader',
    platformAccountId: '507f1f77bcf86cd799439011',
    status: 'FUNDED', enabled: true, customerAccessBlocked: false,
    commercialTerms: { profitSplit: 80 },
    platformFinancial: {
      contractVersion: 1, accountCurrency: 'USD', financialRevision: 12,
      initialBalance: '10000', balance: '10500',
    },
  };
}

function stagingCheckpoint() {
  return {
    contractVersion: 'ACG_PAYOUT_SETTLEMENT_CHECKPOINT_V1',
    platformAccountId: '507f1f77bcf86cd799439011',
    accountCurrency: 'USD', financialRevision: 12,
    balance: '10500', initialBalance: '10000', equity: '10500',
    floatingPnl: '0', usedMargin: '0', openPositionCount: 0, activeOrderCount: 0,
    ledgerEntryId: 'ledger-12', ledgerBalanceAfter: '10500',
    checkedAt: '2026-10-08T09:00:00.000Z',
    blockers: [], settled: true, productionPayoutAuthorized: false,
    evidenceHash: 'b'.repeat(64),
  };
}

test('old and new ACG payout requests cannot be orphaned by cancellation during approval', async () => {
  for (const initiallyFlagged of [false, true]) {
    const model = transitionModel(payout({
      status: 'REVIEWING',
      requiresTraderSettlement: initiallyFlagged,
    }));
    const accountModel = { async findOne() { return legacyTraderAccount(); } };
    let enteredReserve;
    const reserving = new Promise(resolve => { enteredReserve = resolve; });
    let finishReserve;
    const delayedReserve = new Promise(resolve => { finishReserve = resolve; });
    let cancelled = false;
    let releaseCalls = 0;
    const traderClient = {
      async getPayoutSettlementCheckpoint() {
        return { checkpoint: stagingCheckpoint() };
      },
      async reservePayout() {
        enteredReserve();
        await delayedReserve;
        if (cancelled) throw new Error('PAYOUT_CANCELLED');
        return { reservation: {
          contractVersion: 'ACG_PAYOUT_RESERVATION_V1',
          status: 'RESERVED', amountUsd: '400',
          payoutId: 'PAYOUT-001',
          platformAccountId: legacyTraderAccount().platformAccountId,
          financialRevision: 12, checkpointHash: 'b'.repeat(64),
        } };
      },
      async releasePayout(_accountId, payoutId) {
        assert.equal(payoutId, 'PAYOUT-001');
        releaseCalls++;
        cancelled = true;
        return { reservation: {
          status: 'CANCELLED', payoutId: 'PAYOUT-001',
          platformAccountId: legacyTraderAccount().platformAccountId,
        } };
      },
    };
    const deps = {
      payoutModel: model, accountModel, traderClient,
      now: () => new Date('2026-10-08T09:00:05.000Z'),
    };
    const approval = transitionAdminPayout('PAYOUT-001',
      { action: 'APPROVE', reason: 'Approve historical payout' }, deps);
    await reserving;
    assert.equal(model.record.requiresTraderSettlement, true);
    const rejected = await transitionAdminPayout('PAYOUT-001',
      { action: 'CANCEL', reason: 'Cancel before reserve returns' }, deps);
    assert.equal(rejected.after.status, 'CANCELLED');
    assert.equal(releaseCalls, 1);
    finishReserve();
    await assert.rejects(approval, /Trader payout reservation was not confirmed/);
    assert.equal(model.record.status, 'CANCELLED');
    assert.equal(model.record.activeKey, null);
  }
});

test('old ACG payout reserve timeout followed by cancellation releases unacknowledged hold', async () => {
  const model = transitionModel(payout({
    status: 'REVIEWING', requiresTraderSettlement: false,
  }));
  const accountModel = { async findOne() { return legacyTraderAccount(); } };
  let traderHold = false;
  const traderClient = {
    async getPayoutSettlementCheckpoint() { return { checkpoint: stagingCheckpoint() }; },
    async reservePayout() {
      traderHold = true;
      throw new Error('network timeout after reserve committed');
    },
    async releasePayout(_accountId, id) {
      assert.equal(id, 'PAYOUT-001');
      assert.equal(traderHold, true);
      traderHold = false;
      return { reservation: {
        status: 'RELEASED', payoutId: id,
        platformAccountId: legacyTraderAccount().platformAccountId,
      } };
    },
  };
  const deps = { payoutModel: model, accountModel, traderClient,
    now: () => new Date('2026-10-08T09:00:05.000Z') };
  await assert.rejects(
    transitionAdminPayout('PAYOUT-001',
      { action: 'APPROVE', reason: 'Attempt reserve' }, deps),
    error => error.code === 'PAYOUT_TRADER_RESERVATION_UNAVAILABLE',
  );
  assert.equal(model.record.requiresTraderSettlement, true);
  assert.equal(model.record.status, 'REVIEWING');
  const cancelled = await transitionAdminPayout('PAYOUT-001',
    { action: 'REJECT', reason: 'Cancel after uncertain reserve' }, deps);
  assert.equal(cancelled.after.status, 'REJECTED');
  assert.equal(traderHold, false);
});
