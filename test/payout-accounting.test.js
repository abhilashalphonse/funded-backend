import test from "node:test";
import assert from "node:assert/strict";
import {
  assertExactTraderReceipt,
  buildPaidPayoutAccounting,
} from "../src/apis/services/payoutAccounting.service.js";

const payout = {
  feePolicy: "ACG_COVERS",
  settlementCurrency: "INR",
  settlementAmount: 1000,
};

test("exact receipt accounting keeps provider fees outside the trader payout", () => {
  const accounting = buildPaidPayoutAccounting(payout, {
    traderReceivedAmount: 1000,
    providerFeePaidByAcg: 30,
    source: "ADMIN_VERIFIED",
    verifiedAt: new Date("2026-09-29T20:00:00.000Z"),
  });

  assert.deepEqual(accounting, {
    traderReceivedAmount: 1000,
    providerFeePaidByAcg: 30,
    acgTotalCostAmount: 1030,
    accountingCurrency: "INR",
    accountingSource: "ADMIN_VERIFIED",
    accountingVerifiedAt: new Date("2026-09-29T20:00:00.000Z"),
  });
});

test("ACG-covered fee policy rejects a fee-deducted trader receipt", () => {
  assert.throws(
    () => assertExactTraderReceipt(payout, 970),
    error => error?.code === "PAYOUT_EXACT_RECEIPT_MISMATCH"
      && error?.expectedAmount === 1000
      && error?.receivedAmount === 970
      && error?.currency === "INR",
  );
});

test("payout can be marked paid with a zero provider fee when the exact receipt is verified", () => {
  const accounting = buildPaidPayoutAccounting(payout, {
    traderReceivedAmount: 1000,
    providerFeePaidByAcg: 0,
  });

  assert.equal(accounting.traderReceivedAmount, 1000);
  assert.equal(accounting.providerFeePaidByAcg, 0);
  assert.equal(accounting.acgTotalCostAmount, 1000);
});

test("provider fee accounting is mandatory before paid status", () => {
  assert.throws(
    () => buildPaidPayoutAccounting(payout, {
      traderReceivedAmount: 1000,
    }),
    error => error?.code === "PAYOUT_PROVIDER_FEE_REQUIRED",
  );
});
