import { PAYOUT_PROVIDER_FEE_POLICY } from "./payoutPolicy.js";

function money2(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function accountingError(message, code) {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  return error;
}

export function assertExactTraderReceipt(record, receivedAmount) {
  const expected = money2(record?.settlementAmount);
  const received = money2(receivedAmount);

  if (!Number.isFinite(expected) || expected <= 0) {
    throw accountingError(
      "The payout does not have a valid quoted settlement amount.",
      "PAYOUT_SETTLEMENT_AMOUNT_REQUIRED",
    );
  }
  if (!Number.isFinite(received) || received <= 0) {
    throw accountingError(
      "The trader received amount must be recorded before a payout can be marked paid.",
      "PAYOUT_RECEIVED_AMOUNT_REQUIRED",
    );
  }

  if (
    String(record?.feePolicy || PAYOUT_PROVIDER_FEE_POLICY) === "ACG_COVERS"
    && received !== expected
  ) {
    const error = accountingError(
      "The trader received amount must exactly match the quoted payout because ACG covers provider fees.",
      "PAYOUT_EXACT_RECEIPT_MISMATCH",
    );
    error.expectedAmount = expected;
    error.receivedAmount = received;
    error.currency = String(record?.settlementCurrency || "").toUpperCase() || null;
    throw error;
  }

  return { expectedAmount: expected, receivedAmount: received };
}

export function buildPaidPayoutAccounting(
  record,
  {
    traderReceivedAmount,
    providerFeePaidByAcg,
    source,
    verifiedAt = new Date(),
  } = {},
) {
  const { receivedAmount } = assertExactTraderReceipt(record, traderReceivedAmount);

  const providerFee = money2(providerFeePaidByAcg);
  if (!Number.isFinite(providerFee) || providerFee < 0) {
    const error = new Error("Provider fee paid by ACG must be recorded as zero or a positive amount.");
    error.status = 400;
    error.code = "PAYOUT_PROVIDER_FEE_REQUIRED";
    throw error;
  }

  return {
    traderReceivedAmount: receivedAmount,
    providerFeePaidByAcg: providerFee,
    acgTotalCostAmount: money2(receivedAmount + providerFee),
    accountingCurrency: String(record?.settlementCurrency || "").toUpperCase() || null,
    accountingSource: String(source || "ADMIN_VERIFIED").trim().toUpperCase(),
    accountingVerifiedAt: verifiedAt,
  };
}
