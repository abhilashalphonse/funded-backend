import Account from "../../accounts/account.model.js";
import PayoutRequest from "../../models/payoutRequest.model.js";
import { decryptPayoutDestination } from "./payoutDestination.service.js";
import { buildPaidPayoutAccounting } from "./payoutAccounting.service.js";

const ACTIONS = Object.freeze({
  START_REVIEW: { from: ["REQUESTED"], to: "REVIEWING", timestamp: "reviewingAt" },
  APPROVE: { from: ["REQUESTED", "REVIEWING"], to: "APPROVED", timestamp: "approvedAt" },
  MARK_PROCESSING: { from: ["APPROVED"], to: "PROCESSING", timestamp: "processingAt" },
  MARK_SENT: { from: ["PROCESSING"], to: "SENT", timestamp: "sentAt" },
  MARK_PAID: { from: ["SENT"], to: "PAID", timestamp: "paidAt", terminal: true },
  REJECT: { from: ["REQUESTED", "REVIEWING"], to: "REJECTED", timestamp: "rejectedAt", terminal: true },
  FAIL: { from: ["APPROVED", "PROCESSING", "SENT"], to: "FAILED", timestamp: "failedAt", terminal: true },
  CANCEL: { from: ["REQUESTED", "REVIEWING"], to: "CANCELLED", timestamp: "cancelledAt", terminal: true },
});

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}

function money2(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function plain(record) {
  if (!record) return null;
  return typeof record.toObject === "function" ? record.toObject() : record;
}

export function serializeAdminPayout(raw) {
  const record = plain(raw) || {};
  return {
    id: record._id ? String(record._id) : null,
    payoutId: record.payoutId || null,
    customerId: record.customerId || null,
    accountId: record.accountId || null,
    status: record.status || null,
    requestedAmountUsd: money2(record.requestedAmountUsd),
    feePolicy: record.feePolicy || "ACG_COVERS",
    method: record.method || null,
    settlementCurrency: record.settlementCurrency || null,
    settlementAmount: record.settlementAmount == null ? null : money2(record.settlementAmount),
    fxRate: record.fxRate == null ? null : Number(record.fxRate),
    quoteSource: record.quoteSource || null,
    quoteDate: record.quoteDate || null,
    quoteStatus: record.quoteStatus || null,
    destination: record.destination || null,
    cycle: record.cycle || null,
    snapshot: record.snapshot || null,
    provider: record.provider || null,
    providerReference: record.providerReference || null,
    providerStatus: record.providerStatus || null,
    providerFee: record.providerFee == null ? null : money2(record.providerFee),
    providerGrossAmount: record.providerGrossAmount == null ? null : money2(record.providerGrossAmount),
    providerNetAmount: record.providerNetAmount == null ? null : money2(record.providerNetAmount),
    traderReceivedAmount: record.traderReceivedAmount == null ? null : money2(record.traderReceivedAmount),
    providerFeePaidByAcg: record.providerFeePaidByAcg == null ? null : money2(record.providerFeePaidByAcg),
    acgTotalCostAmount: record.acgTotalCostAmount == null ? null : money2(record.acgTotalCostAmount),
    accountingCurrency: record.accountingCurrency || null,
    accountingSource: record.accountingSource || null,
    accountingVerifiedAt: record.accountingVerifiedAt || null,
    providerStatusCheckedAt: record.providerStatusCheckedAt || null,
    providerLastAttemptAt: record.providerLastAttemptAt || null,
    providerLastError: record.providerLastError?.code || record.providerLastError?.message
      ? record.providerLastError
      : null,
    providerWebhookAt: record.providerWebhookAt || null,
    utr: record.utr || null,
    txHash: record.txHash || null,
    network: record.network || null,
    failure: record.failure?.code || record.failure?.message ? record.failure : null,
    requestedAt: record.requestedAt || record.createdAt || null,
    reviewingAt: record.reviewingAt || null,
    approvedAt: record.approvedAt || null,
    processingAt: record.processingAt || null,
    sentAt: record.sentAt || null,
    paidAt: record.paidAt || null,
    failedAt: record.failedAt || null,
    rejectedAt: record.rejectedAt || null,
    cancelledAt: record.cancelledAt || null,
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
  };
}

export async function listAdminPayouts(
  {
    page = 1,
    limit = 50,
    q = "",
    status = "",
    method = "",
  } = {},
  { payoutModel = PayoutRequest } = {},
) {
  const safePage = Math.max(Number(page) || 1, 1);
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 250);
  const filter = {};

  const normalizedStatus = String(status || "").trim().toUpperCase();
  if (normalizedStatus) filter.status = normalizedStatus;

  const normalizedMethod = String(method || "").trim().toUpperCase();
  if (normalizedMethod) filter.method = normalizedMethod;

  const search = String(q || "").trim();
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    filter.$or = [
      { payoutId: rx },
      { customerId: rx },
      { accountId: rx },
      { providerReference: rx },
      { utr: rx },
      { txHash: rx },
    ];
  }

  const skip = (safePage - 1) * safeLimit;
  const [rows, total] = await Promise.all([
    payoutModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(safeLimit).lean(),
    payoutModel.countDocuments(filter),
  ]);

  return {
    rows: rows.map(serializeAdminPayout),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.max(1, Math.ceil(total / safeLimit)),
    },
  };
}

export async function getAdminPayout(
  payoutId,
  {
    payoutModel = PayoutRequest,
    destinationDecryptor = decryptPayoutDestination,
  } = {},
) {
  const id = String(payoutId || "").trim();
  let query = payoutModel.findOne({ payoutId: id });
  if (typeof query?.select === "function") {
    query = query.select("+destinationEncrypted +destinationIv +destinationAuthTag +destinationKeyVersion");
  }
  const record = await query;
  if (!record) {
    const error = new Error("Payout not found.");
    error.status = 404;
    error.code = "PAYOUT_NOT_FOUND";
    throw error;
  }

  let destinationDetails = null;
  let destinationError = null;
  try {
    destinationDetails = destinationDecryptor(record);
  } catch (error) {
    destinationError = {
      code: error?.code || "PAYOUT_DESTINATION_UNAVAILABLE",
      message: String(error?.message || "Payout destination could not be decrypted."),
    };
  }

  return {
    payout: serializeAdminPayout(record),
    destinationDetails,
    destinationError,
  };
}

export async function assertPayoutApprovalEligible(
  payout,
  {
    accountModel = Account,
    payoutModel = PayoutRequest,
  } = {},
) {
  const account = await accountModel.findOne({ accountId: String(payout?.accountId || "") });
  if (!account) {
    const error = new Error("The Master Account for this payout no longer exists.");
    error.status = 409;
    error.code = "PAYOUT_APPROVAL_ACCOUNT_UNAVAILABLE";
    throw error;
  }

  if (
    String(account.status || "").toUpperCase() !== "FUNDED"
    || account.enabled === false
    || account.customerAccessBlocked === true
  ) {
    const error = new Error("The Master Account is no longer active for payout approval.");
    error.status = 409;
    error.code = "PAYOUT_APPROVAL_ACCOUNT_INACTIVE";
    throw error;
  }

  const currentSplit = Number(account?.commercialTerms?.profitSplit);
  const snapshottedSplit = Number(payout?.snapshot?.profitSplitPercent);
  if (
    !Number.isFinite(currentSplit)
    || currentSplit <= 0
    || !Number.isFinite(snapshottedSplit)
    || currentSplit !== snapshottedSplit
  ) {
    const error = new Error("Profit-split terms changed after this payout was requested.");
    error.status = 409;
    error.code = "PAYOUT_APPROVAL_TERMS_CHANGED";
    throw error;
  }

  const realizedProfit = Math.max(0, Number(account?.projections?.profit || 0));
  const entitlement = Math.round((realizedProfit * currentSplit / 100 + Number.EPSILON) * 100) / 100;

  let paidQuery = payoutModel.find({
    accountId: String(payout.accountId),
    status: "PAID",
  });
  if (typeof paidQuery?.lean === "function") paidQuery = paidQuery.lean();
  const paidRows = await paidQuery;
  const alreadyPaid = (Array.isArray(paidRows) ? paidRows : [])
    .reduce((sum, row) => sum + Math.max(0, Number(row?.requestedAmountUsd || 0)), 0);
  const remaining = Math.round((Math.max(0, entitlement - alreadyPaid) + Number.EPSILON) * 100) / 100;
  const requested = Math.round((Math.max(0, Number(payout?.requestedAmountUsd || 0)) + Number.EPSILON) * 100) / 100;

  if (remaining < requested) {
    const error = new Error("Realized profit changed and no longer covers this payout request.");
    error.status = 409;
    error.code = "PAYOUT_APPROVAL_FUNDS_CHANGED";
    error.availableUsd = remaining;
    error.requestedUsd = requested;
    throw error;
  }

  return {
    realizedProfitUsd: Math.round((realizedProfit + Number.EPSILON) * 100) / 100,
    entitlementUsd: entitlement,
    alreadyPaidUsd: Math.round((alreadyPaid + Number.EPSILON) * 100) / 100,
    availableForApprovalUsd: remaining,
  };
}

function normalizeTransitionInput(input = {}) {
  const action = String(input.action || "").trim().toUpperCase();
  const definition = ACTIONS[action];
  if (!definition) {
    const error = new Error("Unsupported payout action.");
    error.status = 400;
    error.code = "UNSUPPORTED_PAYOUT_ACTION";
    throw error;
  }

  const reason = String(input.reason || "").trim();
  if (!reason) {
    const error = new Error("A reason is required for payout actions.");
    error.status = 400;
    error.code = "PAYOUT_ACTION_REASON_REQUIRED";
    throw error;
  }

  return { action, definition, reason };
}

function providerPatch(record, action, input = {}) {
  const patch = {};
  const provider = String(input.provider || "").trim();
  const providerReference = String(input.providerReference || "").trim();
  const utr = String(input.utr || "").trim();
  const txHash = String(input.txHash || "").trim();
  const network = String(input.network || "").trim().toUpperCase();

  if (provider) patch.provider = provider;
  if (providerReference) patch.providerReference = providerReference;
  if (utr) patch.utr = utr;
  if (txHash) patch.txHash = txHash;
  if (network) patch.network = network;

  if (input.settlementAmount !== undefined && input.settlementAmount !== null && input.settlementAmount !== "") {
    const settlementAmount = Number(input.settlementAmount);
    if (!Number.isFinite(settlementAmount) || settlementAmount <= 0) {
      const error = new Error("Settlement amount must be greater than zero.");
      error.status = 400;
      error.code = "INVALID_PAYOUT_SETTLEMENT_AMOUNT";
      throw error;
    }

    const normalizedAmount = money2(settlementAmount);
    const currentAmount = money2(record?.settlementAmount);
    if (
      String(record?.quoteStatus || "").toUpperCase() === "LOCKED"
      && Number.isFinite(currentAmount)
      && normalizedAmount !== currentAmount
    ) {
      const error = new Error("The quoted payout settlement amount is locked and cannot be changed.");
      error.status = 409;
      error.code = "PAYOUT_SETTLEMENT_IMMUTABLE";
      throw error;
    }
    patch.settlementAmount = normalizedAmount;
  }

  if (input.settlementCurrency) {
    const normalizedCurrency = String(input.settlementCurrency).trim().toUpperCase();
    const currentCurrency = String(record?.settlementCurrency || "").trim().toUpperCase();
    if (
      String(record?.quoteStatus || "").toUpperCase() === "LOCKED"
      && currentCurrency
      && normalizedCurrency !== currentCurrency
    ) {
      const error = new Error("The quoted payout settlement currency is locked and cannot be changed.");
      error.status = 409;
      error.code = "PAYOUT_SETTLEMENT_IMMUTABLE";
      throw error;
    }
    patch.settlementCurrency = normalizedCurrency;
  }

  if (action === "MARK_SENT") {
    const method = String(record?.method || "").toUpperCase();
    const effectiveTxHash = txHash || record?.txHash;
    const effectiveReference = providerReference || utr || record?.providerReference || record?.utr;

    if (method === "USDT" && !effectiveTxHash) {
      const error = new Error("A transaction hash is required before a USDT payout can be marked sent.");
      error.status = 400;
      error.code = "PAYOUT_TX_HASH_REQUIRED";
      throw error;
    }
    if (["UPI", "BANK"].includes(method) && !effectiveReference) {
      const error = new Error("A provider reference or UTR is required before this payout can be marked sent.");
      error.status = 400;
      error.code = "PAYOUT_TRANSFER_REFERENCE_REQUIRED";
      throw error;
    }
  }

  return patch;
}

export async function transitionAdminPayout(
  payoutId,
  input = {},
  {
    payoutModel = PayoutRequest,
    accountModel = Account,
    approvalGuard = assertPayoutApprovalEligible,
    now = () => new Date(),
  } = {},
) {
  const { action, definition, reason } = normalizeTransitionInput(input);
  const id = String(payoutId || "").trim();
  const current = await payoutModel.findOne({ payoutId: id });
  if (!current) {
    const error = new Error("Payout not found.");
    error.status = 404;
    error.code = "PAYOUT_NOT_FOUND";
    throw error;
  }

  const currentStatus = String(current.status || "").toUpperCase();
  if (!definition.from.includes(currentStatus)) {
    const error = new Error(`Payout cannot move from ${currentStatus || "UNKNOWN"} using ${action}.`);
    error.status = 409;
    error.code = "INVALID_PAYOUT_STATUS_TRANSITION";
    error.currentStatus = currentStatus;
    error.allowedStatuses = definition.from;
    throw error;
  }

  if (action === "APPROVE") {
    await approvalGuard(current, { accountModel, payoutModel });
  }

  const at = now();
  const patch = providerPatch(current, action, input);
  const effectiveRecord = { ...plain(current), ...patch };
  const accounting = action === "MARK_PAID"
    ? buildPaidPayoutAccounting(effectiveRecord, {
        traderReceivedAmount: input.traderReceivedAmount,
        providerFeePaidByAcg: input.providerFeePaidByAcg,
        source: "ADMIN_VERIFIED",
        verifiedAt: at,
      })
    : {};

  const set = {
    status: definition.to,
    [definition.timestamp]: at,
    ...patch,
    ...accounting,
  };

  if (definition.terminal) set.activeKey = null;
  if (["REJECT", "FAIL", "CANCEL"].includes(action)) {
    set.failure = {
      code: input.failureCode
        ? String(input.failureCode).trim().toUpperCase().slice(0, 80)
        : `ADMIN_${definition.to}`,
      message: reason.slice(0, 1000),
    };
  } else {
    set.failure = { code: null, message: null };
  }

  const updated = await payoutModel.findOneAndUpdate(
    { payoutId: id, status: { $in: definition.from } },
    { $set: set },
    { new: true, runValidators: true },
  );

  if (!updated) {
    const error = new Error("Payout changed state while this action was being applied. Refresh and try again.");
    error.status = 409;
    error.code = "PAYOUT_STATUS_CHANGED";
    throw error;
  }

  return {
    action,
    reason,
    before: serializeAdminPayout(current),
    after: serializeAdminPayout(updated),
  };
}

export { ACTIONS as PAYOUT_ADMIN_ACTIONS };
