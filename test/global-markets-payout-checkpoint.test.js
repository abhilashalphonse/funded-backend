import test from "node:test";
import assert from "node:assert/strict";
import {
  assertTraderPayoutCheckpoint,
  computeApprovalAmounts,
  fetchTraderPayoutCheckpoint,
} from "../src/apis/services/payoutSettlementCheckpoint.service.js";

const NOW = new Date("2026-10-08T09:00:00.000Z");
function account(overrides = {}) {
  return {
    accountId: "MASTER-1",
    platform: "acg-trader",
    platformAccountId: "507f1f77bcf86cd799439011",
    platformFinancial: {
      contractVersion: 1,
      accountCurrency: "USD",
      financialRevision: 12,
      initialBalance: "10000",
      balance: "10500.12",
    },
    ...overrides,
  };
}
function checkpoint(overrides = {}) {
  return {
    contractVersion: "ACG_PAYOUT_SETTLEMENT_CHECKPOINT_V1",
    platformAccountId: "507f1f77bcf86cd799439011",
    accountCurrency: "USD",
    financialRevision: 12,
    riskSequence: 8,
    lastEvaluatedRiskSequence: 8,
    balance: "10500.12",
    initialBalance: "10000",
    equity: "10500.12",
    floatingPnl: "0",
    usedMargin: "0",
    openPositionCount: 0,
    activeOrderCount: 0,
    ledgerEntryId: "ledger-12",
    ledgerBalanceAfter: "10500.12",
    checkedAt: NOW.toISOString(),
    blockers: [],
    settled: true,
    productionPayoutAuthorized: false,
    evidenceHash: "a".repeat(64),
    ...overrides,
  };
}

test("reconciled live Trader checkpoint derives realized USD profit without JS floating-point arithmetic", () => {
  const result = assertTraderPayoutCheckpoint({ account: account(), checkpoint: checkpoint(), now: NOW });
  assert.equal(result.realizedProfitUsd, "500.12");
  assert.equal(result.financialRevision, 12);
  assert.equal(result.evidenceHash, "a".repeat(64));
});

test("stale, wrong account, wrong currency and revision drift are blocked", () => {
  for (const c of [
    checkpoint({ checkedAt: new Date(NOW.getTime() - 20000).toISOString() }),
    checkpoint({ platformAccountId: "another" }),
    checkpoint({ accountCurrency: "INR" }),
    checkpoint({ financialRevision: 11 }),
    checkpoint({ ledgerBalanceAfter: "10400" }),
  ]) {
    assert.throws(
      () => assertTraderPayoutCheckpoint({ account: account(), checkpoint: c, now: NOW }),
      error => String(error?.code || "").startsWith("PAYOUT_TRADER_"),
    );
  }
});

test("payout share rounds down to the cent and subtracts already-paid amounts exactly", () => {
  const amount = computeApprovalAmounts({
    realizedProfitUsd: "500.12",
    profitSplitPercent: "80",
    paidAmounts: ["50.01", "100.02"],
    requestedAmountUsd: "250.06",
  });
  assert.equal(amount.entitlementUsd, "400.09");
  assert.equal(amount.alreadyPaidUsd, "150.03");
  assert.equal(amount.availableForApprovalUsd, "250.06");
  assert.equal(amount.sufficient, true);
});

test("Trader checkpoint network failure blocks; no Funded projection fallback", async () => {
  await assert.rejects(
    fetchTraderPayoutCheckpoint(account(), {
      traderClient: { async getPayoutSettlementCheckpoint() { throw new Error("offline"); } },
      now: () => NOW,
    }),
    error => error.code === "PAYOUT_TRADER_CHECKPOINT_UNAVAILABLE",
  );
});

test("non-Trader account does not invoke the Trader dependency", async () => {
  assert.equal(await fetchTraderPayoutCheckpoint({
    platform: "simulator",
  }, {
    traderClient: { async getPayoutSettlementCheckpoint() { throw new Error("must not call"); } },
  }), null);
});
