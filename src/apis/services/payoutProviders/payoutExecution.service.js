import PayoutRequest from "../../../models/payoutRequest.model.js";
import Account from "../../../accounts/account.model.js";
import {
  settleVerifiedTraderPayout,
  releaseVerifiedTraderPayout,
} from "../payoutSettlementCheckpoint.service.js";
import { decryptPayoutDestination } from "../payoutDestination.service.js";
import { buildPaidPayoutAccounting } from "../payoutAccounting.service.js";
import {
  createSunpayPayout,
  getSunpayPayoutBalance,
  getSunpayPayoutStatus,
} from "./sunpayPayout.service.js";
import { assertAutomaticPayoutExecutionAllowed } from "./payoutProvider.registry.js";

function plain(record) {
  if (!record) return null;
  return typeof record.toObject === "function" ? record.toObject() : record;
}

function money2(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function executionError(error) {
  return {
    code: String(error?.code || "SUNPAY_PAYOUT_EXECUTION_FAILED").slice(0, 120),
    message: String(error?.message || "Sunpay payout execution failed.").slice(0, 1000),
    status: Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
    minimum: Number.isFinite(Number(error?.providerPayload?.minimum)) ? Number(error.providerPayload.minimum) : null,
    maximum: Number.isFinite(Number(error?.providerPayload?.maximum)) ? Number(error.providerPayload.maximum) : null,
  };
}

async function findPayoutWithDestination(payoutModel, payoutId) {
  let query = payoutModel.findOne({ payoutId: String(payoutId || "").trim() });
  if (typeof query?.select === "function") {
    query = query.select("+destinationEncrypted +destinationIv +destinationAuthTag +destinationKeyVersion");
  }
  return query;
}

function beneficiaryPayload(record, destination) {
  const method = String(record?.method || "").toUpperCase();
  if (method === "UPI") {
    return {
      method: "upi",
      beneficiaryName: destination?.beneficiaryName,
      beneficiaryAccount: destination?.upiId,
      beneficiaryPhone: destination?.beneficiaryPhone || null,
    };
  }

  if (method === "BANK") {
    return {
      method: "bank",
      beneficiaryName: destination?.beneficiaryName,
      beneficiaryAccount: destination?.accountNumber,
      ifsc: destination?.ifsc,
      bankName: destination?.bankName,
    };
  }

  const error = new Error("Sunpay automatic execution only supports UPI and bank payouts.");
  error.status = 409;
  error.code = "SUNPAY_PAYOUT_METHOD_UNSUPPORTED";
  throw error;
}

export async function executeApprovedSunpayPayout(
  payoutId,
  {
    payoutModel = PayoutRequest,
    now = () => new Date(),
    destinationDecryptor = decryptPayoutDestination,
    balanceFetcher = getSunpayPayoutBalance,
    payoutCreator = createSunpayPayout,
    statusFetcher = getSunpayPayoutStatus,
    executionGuard = assertAutomaticPayoutExecutionAllowed,
  } = {},
) {
  const record = await findPayoutWithDestination(payoutModel, payoutId);
  if (!record) {
    const error = new Error("Payout not found.");
    error.status = 404;
    error.code = "PAYOUT_NOT_FOUND";
    throw error;
  }

  const status = String(record.status || "").toUpperCase();
  if (["PROCESSING", "SENT"].includes(status) && String(record.provider || "").toLowerCase() === "sunpay") {
    return reconcileSunpayPayout(record.payoutId, { payoutModel, now, statusFetcher });
  }
  if (["PAID", "FAILED", "REJECTED", "CANCELLED"].includes(status)) return plain(record);
  if (status !== "APPROVED") {
    const error = new Error("Payout must be approved before Sunpay execution.");
    error.status = 409;
    error.code = "PAYOUT_NOT_APPROVED_FOR_EXECUTION";
    throw error;
  }

  if (record.requiresTraderSettlement === true
    && record?.traderReservation?.status !== "RESERVED") {
    const error = new Error("Authoritative Trader payout reservation is required before provider execution.");
    error.status = 409;
    error.code = "PAYOUT_TRADER_RESERVATION_REQUIRED";
    throw error;
  }

  // Defense in depth: callers cannot bypass provider readiness by invoking this
  // service directly. Reconciliation remains available for already-submitted
  // payouts, but creating a new Sunpay payout requires an explicitly ready
  // automatic provider.
  executionGuard(record.method, "sunpay");

  const settlementAmount = money2(record.settlementAmount);
  if (
    String(record.settlementCurrency || "").toUpperCase() !== "INR"
    || !Number.isFinite(settlementAmount)
    || settlementAmount <= 0
  ) {
    const error = new Error("An exact INR settlement amount is required before Sunpay execution.");
    error.status = 409;
    error.code = "PAYOUT_SETTLEMENT_AMOUNT_REQUIRED";
    throw error;
  }

  const destination = destinationDecryptor(record);
  const beneficiary = beneficiaryPayload(record, destination);
  const attemptAt = now();

  try {
    const balance = await balanceFetcher("INR");
    if (Number.isFinite(Number(balance?.balance)) && Number(balance.balance) < settlementAmount) {
      const error = new Error("Sunpay merchant balance is insufficient for this payout.");
      error.status = 409;
      error.code = "SUNPAY_INSUFFICIENT_BALANCE";
      error.availableBalance = Number(balance.balance);
      throw error;
    }

    const created = await payoutCreator({
      payoutId: record.payoutId,
      amountInr: settlementAmount,
      ...beneficiary,
    });

    const set = {
      status: "PROCESSING",
      provider: "sunpay",
      providerReference: created.providerReference || record.providerReference || null,
      providerStatus: created.providerStatus || null,
      providerFee: created.fee == null ? null : money2(created.fee),
      providerGrossAmount: created.amount == null ? settlementAmount : money2(created.amount),
      providerNetAmount: created.netAmount == null ? null : money2(created.netAmount),
      providerStatusCheckedAt: attemptAt,
      providerLastAttemptAt: attemptAt,
      providerLastError: { code: null, message: null, status: null },
      processingAt: record.processingAt || attemptAt,
    };

    const updated = await payoutModel.findOneAndUpdate(
      { payoutId: record.payoutId, status: "APPROVED" },
      { $set: set },
      { new: true, runValidators: true },
    );

    if (!updated) {
      const current = await payoutModel.findOne({ payoutId: record.payoutId });
      if (current && ["PROCESSING", "SENT", "PAID", "FAILED"].includes(String(current.status || "").toUpperCase())) {
        return plain(current);
      }
      const error = new Error("Payout state changed while Sunpay execution was starting.");
      error.status = 409;
      error.code = "PAYOUT_STATUS_CHANGED";
      throw error;
    }

    return reconcileSunpayPayout(record.payoutId, { payoutModel, now, statusFetcher });
  } catch (error) {
    await payoutModel.findOneAndUpdate(
      { payoutId: record.payoutId, status: "APPROVED" },
      {
        $set: {
          provider: "sunpay",
          providerLastAttemptAt: attemptAt,
          providerLastError: executionError(error),
        },
      },
      { new: true },
    ).catch(() => null);
    throw error;
  }
}

export async function reconcileSunpayPayout(
  payoutId,
  {
    payoutModel = PayoutRequest,
    now = () => new Date(),
    statusFetcher = getSunpayPayoutStatus,
    accountModel = Account,
    traderClient = null,
  } = {},
) {
  const record = await payoutModel.findOne({ payoutId: String(payoutId || "").trim() });
  if (!record) {
    const error = new Error("Payout not found.");
    error.status = 404;
    error.code = "PAYOUT_NOT_FOUND";
    throw error;
  }

  const currentStatus = String(record.status || "").toUpperCase();
  if (["PAID", "FAILED", "REJECTED", "CANCELLED"].includes(currentStatus)) return plain(record);

  const provider = String(record.provider || "").toLowerCase();
  if (provider && provider !== "sunpay") {
    const error = new Error("This payout is not assigned to Sunpay.");
    error.status = 409;
    error.code = "PAYOUT_PROVIDER_MISMATCH";
    throw error;
  }

  const checkedAt = now();
  let remote;
  try {
    remote = await statusFetcher(record.payoutId);
  } catch (error) {
    await payoutModel.findOneAndUpdate(
      { payoutId: record.payoutId },
      {
        $set: {
          provider: "sunpay",
          providerStatusCheckedAt: checkedAt,
          providerLastError: executionError(error),
        },
      },
      { new: true },
    ).catch(() => null);
    throw error;
  }

  if (String(remote?.payoutId || "") !== String(record.payoutId)) {
    const error = new Error("Sunpay status response did not match the payout ID.");
    error.status = 502;
    error.code = "SUNPAY_PAYOUT_ID_MISMATCH";
    throw error;
  }

  const set = {
    provider: "sunpay",
    providerReference: remote.providerReference || record.providerReference || null,
    providerStatus: remote.providerStatus || null,
    providerFee: remote.fee == null ? record.providerFee ?? null : money2(remote.fee),
    providerGrossAmount: remote.amount == null ? record.providerGrossAmount ?? null : money2(remote.amount),
    providerNetAmount: remote.netAmount == null ? record.providerNetAmount ?? null : money2(remote.netAmount),
    providerStatusCheckedAt: checkedAt,
    providerLastError: { code: null, message: null, status: null },
  };

  if (remote.utr) set.utr = String(remote.utr);

  if (remote.status === "PAID") {
    const settledAt = remote.settledAt ? new Date(remote.settledAt) : checkedAt;
    try {
      const accounting = buildPaidPayoutAccounting(
        { ...plain(record), ...set },
        {
          traderReceivedAmount: remote.netAmount,
          providerFeePaidByAcg: remote.fee ?? 0,
          source: "PROVIDER_VERIFIED",
          verifiedAt: settledAt,
        },
      );
      const traderSettlement = record.requiresTraderSettlement
        ? await settleVerifiedTraderPayout(record, { accountModel, traderClient })
        : null;
      if (record.requiresTraderSettlement && traderSettlement?.status !== "SETTLED") {
        const error = new Error("Trader settlement receipt is required.");
        error.code = "PAYOUT_TRADER_SETTLEMENT_REQUIRED";
        throw error;
      }
      if (traderSettlement) set.traderReservation = traderSettlement;
      set.status = "PAID";
      set.activeKey = null;
      set.sentAt = record.sentAt || settledAt;
      set.paidAt = record.paidAt || settledAt;
      set.failure = { code: null, message: null };
      Object.assign(set, accounting);
    } catch (error) {
      // ACG covers payout fees, so a provider-reported success is not enough:
      // the beneficiary must have received exactly the quoted trader amount.
      set.status = "PROCESSING";
      set.processingAt = record.processingAt || checkedAt;
      set.providerLastError = {
        code: error?.code || "PAYOUT_EXACT_RECEIPT_MISMATCH",
        message: error?.message || "Provider success did not deliver the full quoted trader amount.",
        status: null,
        minimum: null,
        maximum: null,
        expectedAmount: Number.isFinite(Number(error?.expectedAmount)) ? Number(error.expectedAmount) : null,
        receivedAmount: Number.isFinite(Number(error?.receivedAmount)) ? Number(error.receivedAmount) : null,
        currency: error?.currency || String(record?.settlementCurrency || "").toUpperCase() || null,
      };
    }
  } else if (remote.status === "FAILED") {
    try {
      const released = record.requiresTraderSettlement
        ? await releaseVerifiedTraderPayout(record, {
          accountModel, traderClient, reason: "VERIFIED_SUNPAY_FAILURE",
        })
        : null;
      if (record.requiresTraderSettlement && released?.status !== "RELEASED") {
        const error = new Error("Trader hold release is required before marking payout failed.");
        error.code = "PAYOUT_TRADER_RELEASE_REQUIRED";
        throw error;
      }
      if (released) set.traderReservation = released;
      set.status = "FAILED";
      set.activeKey = null;
      set.failedAt = record.failedAt || checkedAt;
      set.failure = {
        code: "SUNPAY_PROVIDER_FAILED",
        message: "Sunpay reported this payout as failed.",
      };
    } catch (error) {
      // A confirmed provider failure is not enough to free Funded's active
      // reservation unless Trader has released the USD hold.
      set.status = "PROCESSING";
      set.processingAt = record.processingAt || checkedAt;
      set.providerLastError = executionError(error);
    }
  } else {
    set.status = "PROCESSING";
    set.processingAt = record.processingAt || checkedAt;
  }

  const updated = await payoutModel.findOneAndUpdate(
    {
      payoutId: record.payoutId,
      status: { $in: ["APPROVED", "PROCESSING", "SENT"] },
    },
    { $set: set },
    { new: true, runValidators: true },
  );

  return plain(updated || await payoutModel.findOne({ payoutId: record.payoutId }));
}

export async function noteSunpayPayoutWebhook(
  payoutId,
  {
    payoutModel = PayoutRequest,
    now = () => new Date(),
  } = {},
) {
  const updated = await payoutModel.findOneAndUpdate(
    { payoutId: String(payoutId || "").trim() },
    { $set: { providerWebhookAt: now() } },
    { new: true },
  );
  return plain(updated);
}
