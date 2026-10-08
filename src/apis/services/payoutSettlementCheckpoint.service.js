import env from "../../config/env.js";
import { ACGTraderClient } from "../../connectors/acg-trader/client.js";
import {
  normalizeDecimal, subtractDecimal, multiplyDecimal, divideDecimal,
  addDecimal, compareDecimal,
} from "../../utils/decimal.js";

const CHECKPOINT_VERSION = "ACG_PAYOUT_SETTLEMENT_CHECKPOINT_V1";
const MAX_CHECKPOINT_AGE_MS = 10_000;

export function payoutCheckpointError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  return error;
}

export async function fetchTraderPayoutCheckpoint(account, {
  traderClient = null,
  now = () => new Date(),
} = {}) {
  if (String(account?.platform || "").toLowerCase() !== "acg-trader") return null;
  const platformAccountId = String(account?.platformAccountId || "").trim();
  if (!platformAccountId) {
    throw payoutCheckpointError("PAYOUT_TRADER_BINDING_MISSING", "Trader account binding is unavailable.");
  }

  const client = traderClient || new ACGTraderClient({
    baseUrl: env.ACG_TRADER_BASE_URL,
    clientId: env.ACG_TRADER_CLIENT_ID,
    apiKey: env.ACG_TRADER_API_KEY,
    timeoutMs: env.ACG_TRADER_TIMEOUT_MS,
  });
  let payload;
  try {
    payload = await client.getPayoutSettlementCheckpoint(platformAccountId);
  } catch (error) {
    const failure = payoutCheckpointError(
      "PAYOUT_TRADER_CHECKPOINT_UNAVAILABLE",
      "A fresh authoritative Trader settlement checkpoint is required.",
    );
    failure.cause = error;
    throw failure;
  }
  return assertTraderPayoutCheckpoint({
    account,
    checkpoint: payload?.checkpoint,
    now: now(),
  });
}

export function assertTraderPayoutCheckpoint({ account, checkpoint, now = new Date() } = {}) {
  const c = checkpoint;
  const financial = account?.platformFinancial;
  if (!c || c.contractVersion !== CHECKPOINT_VERSION || c.settled !== true
    || c.productionPayoutAuthorized !== false || (c.blockers || []).length !== 0) {
    throw payoutCheckpointError("PAYOUT_TRADER_NOT_SETTLED", "Trader has not confirmed a settled financial account.");
  }
  if (!/^[a-f0-9]{64}$/.test(String(c.evidenceHash || ""))) {
    throw payoutCheckpointError("PAYOUT_TRADER_CHECKPOINT_INVALID", "The Trader settlement evidence is missing.");
  }
  if (String(c.platformAccountId || "") !== String(account?.platformAccountId || "")
      || c.accountCurrency !== "USD") {
    throw payoutCheckpointError("PAYOUT_TRADER_CHECKPOINT_MISMATCH", "Trader account or currency does not match Funded.");
  }
  const ageMs = new Date(now).getTime() - Date.parse(c.checkedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > MAX_CHECKPOINT_AGE_MS) {
    throw payoutCheckpointError("PAYOUT_TRADER_CHECKPOINT_STALE", "Trader settlement evidence is too old.");
  }
  if (!financial || Number(financial.contractVersion) !== 1
    || String(financial.accountCurrency || "") !== "USD"
    || !Number.isSafeInteger(Number(financial.financialRevision))
    || Number(financial.financialRevision) !== Number(c.financialRevision)
    || financial.balance == null || financial.initialBalance == null
    || compareDecimal(financial.balance, c.balance) !== 0
    || compareDecimal(financial.initialBalance, c.initialBalance) !== 0) {
    throw payoutCheckpointError("PAYOUT_TRADER_REVISION_DRIFT", "Funded must reconcile the latest Trader revision before approval.");
  }
  if (c.openPositionCount !== 0 || c.activeOrderCount !== 0
    || compareDecimal(c.equity, c.balance) !== 0
    || compareDecimal(c.usedMargin, "0") !== 0
    || compareDecimal(c.floatingPnl, "0") !== 0
    || compareDecimal(c.ledgerBalanceAfter, c.balance) !== 0) {
    throw payoutCheckpointError("PAYOUT_TRADER_FINANCIAL_DRIFT", "Trader financial invariants are not settled.");
  }
  const realizedProfitUsd = compareDecimal(c.balance, c.initialBalance) > 0
    ? subtractDecimal(c.balance, c.initialBalance)
    : "0";
  return Object.freeze({
    platformAccountId: c.platformAccountId,
    accountCurrency: "USD",
    financialRevision: c.financialRevision,
    traderBalanceUsd: normalizeDecimal(c.balance),
    initialBalanceUsd: normalizeDecimal(c.initialBalance),
    realizedProfitUsd,
    ledgerEntryId: c.ledgerEntryId,
    evidenceHash: c.evidenceHash,
    checkedAt: new Date(c.checkedAt),
    contractVersion: CHECKPOINT_VERSION,
  });
}

export function makeTraderClient(traderClient = null) {
  return traderClient || new ACGTraderClient({
    baseUrl: env.ACG_TRADER_BASE_URL,
    clientId: env.ACG_TRADER_CLIENT_ID,
    apiKey: env.ACG_TRADER_API_KEY,
    timeoutMs: env.ACG_TRADER_TIMEOUT_MS,
  });
}

export async function reserveVerifiedTraderPayout({ account, checkpoint, payoutId, amountUsd, traderClient = null }) {
  if (!checkpoint || !payoutId || !account?.platformAccountId) {
    throw payoutCheckpointError("PAYOUT_RESERVATION_EVIDENCE_REQUIRED", "A fresh verified Trader checkpoint is required.");
  }
  const amount = normalizeDecimal(amountUsd);
  let response;
  try {
    response = await makeTraderClient(traderClient).reservePayout(account.platformAccountId, {
      payoutId, amountUsd: amount,
      financialRevision: checkpoint.financialRevision,
      checkpointHash: checkpoint.evidenceHash,
    });
  } catch (error) {
    const failure = payoutCheckpointError("PAYOUT_TRADER_RESERVATION_UNAVAILABLE", "Trader payout reservation was not confirmed.");
    failure.cause = error;
    throw failure;
  }
  const record = response?.reservation;
  if (record?.contractVersion !== "ACG_PAYOUT_RESERVATION_V1"
    || record.payoutId !== payoutId
    || record.status !== "RESERVED"
    || String(record.platformAccountId) !== String(account.platformAccountId)
    || compareDecimal(record.amountUsd, amount) !== 0
    || record.financialRevision !== checkpoint.financialRevision
    || record.checkpointHash !== checkpoint.evidenceHash) {
    throw payoutCheckpointError("PAYOUT_TRADER_RESERVATION_MISMATCH", "Trader payout reservation does not match the approved financial terms.");
  }
  return {
    contractVersion: record.contractVersion,
    status: "RESERVED",
    amountUsd: amount,
    financialRevision: record.financialRevision,
    checkpointHash: record.checkpointHash,
    reservedAt: record.reservedAt,
  };
}

export async function settleVerifiedTraderPayout(payout, {
  accountModel,
  traderClient = null,
} = {}) {
  const account = await accountModel.findOne({ accountId: String(payout?.accountId || "") });
  if (String(account?.platform || "").toLowerCase() !== "acg-trader") return null;
  if (!account?.platformAccountId || !payout?.traderReservation?.checkpointHash) {
    throw payoutCheckpointError("PAYOUT_RESERVATION_EVIDENCE_REQUIRED", "Trader payout reservation is missing.");
  }
  let response;
  try {
    response = await makeTraderClient(traderClient).settlePayout(account.platformAccountId, payout.payoutId);
  } catch (error) {
    const failure = payoutCheckpointError("PAYOUT_TRADER_SETTLEMENT_UNAVAILABLE", "Trader payout deduction has not been confirmed.");
    failure.cause = error;
    throw failure;
  }
  const record = response?.reservation;
  if (record?.status !== "SETTLED"
    || record?.payoutId !== payout.payoutId
    || record?.checkpointHash !== payout.traderReservation.checkpointHash
    || record?.contractVersion !== "ACG_PAYOUT_RESERVATION_V1"
    || String(record.platformAccountId) !== String(account.platformAccountId)
    || !record.settledLedgerEntryId
    || compareDecimal(record.amountUsd, payout.requestedAmountUsd) !== 0) {
    throw payoutCheckpointError("PAYOUT_TRADER_SETTLEMENT_MISMATCH", "Trader settlement receipt did not match the reserved payout.");
  }
  return {
    ...payout.traderReservation,
    status: "SETTLED",
    settledAt: record.settledAt || new Date(),
    settledLedgerEntryId: record.settledLedgerEntryId,
  };
}

export async function cancelTraderPayoutRequest(payout, {
  accountModel,
  traderClient = null,
  reason,
} = {}) {
  const account = await accountModel.findOne({ accountId: String(payout?.accountId || "") });
  if (String(account?.platform || "").toLowerCase() !== "acg-trader") {
    throw payoutCheckpointError("PAYOUT_TRADER_BINDING_MISSING", "Trader account binding is required to cancel this payout.");
  }
  if (!account.platformAccountId) {
    throw payoutCheckpointError("PAYOUT_TRADER_BINDING_MISSING", "Trader platform account ID is missing.");
  }
  let result;
  try {
    result = await makeTraderClient(traderClient)
      .releasePayout(account.platformAccountId, payout.payoutId, reason);
  } catch (error) {
    const failure = payoutCheckpointError(
      "PAYOUT_TRADER_CANCELLATION_UNCONFIRMED",
      "Trader cancellation and reservation release have not been confirmed.",
    );
    failure.cause = error;
    throw failure;
  }
  const record = result?.reservation;
  if (!["CANCELLED", "RELEASED"].includes(record?.status)
    || record?.payoutId !== payout?.payoutId
    || String(record.platformAccountId) !== String(account.platformAccountId)) {
    throw payoutCheckpointError("PAYOUT_TRADER_CANCELLATION_MISMATCH", "Trader cancellation confirmation did not match the payout.");
  }
  return {
    contractVersion: "ACG_PAYOUT_RESERVATION_V1",
    status: record.status,
    amountUsd: record.amountUsd || payout?.traderReservation?.amountUsd || null,
    financialRevision: record.financialRevision ?? payout?.traderReservation?.financialRevision ?? null,
    checkpointHash: record.checkpointHash || payout?.traderReservation?.checkpointHash || null,
    releasedAt: record.releasedAt || new Date(),
  };
}

export async function releaseVerifiedTraderPayout(payout, {
  accountModel,
  traderClient = null,
  reason,
} = {}) {
  const account = await accountModel.findOne({ accountId: String(payout?.accountId || "") });
  if (String(account?.platform || "").toLowerCase() !== "acg-trader") return null;
  if (!account?.platformAccountId || !payout?.traderReservation?.checkpointHash) {
    throw payoutCheckpointError("PAYOUT_RESERVATION_EVIDENCE_REQUIRED", "Trader payout reservation is missing.");
  }
  const response = await makeTraderClient(traderClient)
    .releasePayout(account.platformAccountId, payout.payoutId, reason);
  if (response?.reservation?.status !== "RELEASED"
    || response.reservation.payoutId !== payout.payoutId) {
    throw payoutCheckpointError("PAYOUT_TRADER_RELEASE_MISMATCH", "Trader has not released the payout reservation.");
  }
  return {
    ...payout.traderReservation,
    status: "RELEASED",
    releasedAt: response.reservation.releasedAt || new Date(),
  };
}

export function computeApprovalAmounts({
  realizedProfitUsd,
  profitSplitPercent,
  paidAmounts = [],
  requestedAmountUsd,
} = {}) {
  const gross = normalizeDecimal(realizedProfitUsd);
  const split = normalizeDecimal(profitSplitPercent);
  const requested = normalizeDecimal(requestedAmountUsd);
  const entitlement = divideDecimal(multiplyDecimal(gross, split), "100", {
    scale: 2,
    rounding: "DOWN",
  });
  const alreadyPaid = paidAmounts.reduce(
    (sum, value) => addDecimal(sum, normalizeDecimal(value)),
    "0",
  );
  const remaining = compareDecimal(entitlement, alreadyPaid) > 0
    ? subtractDecimal(entitlement, alreadyPaid)
    : "0";
  return Object.freeze({
    realizedProfitUsd: gross,
    entitlementUsd: entitlement,
    alreadyPaidUsd: alreadyPaid,
    availableForApprovalUsd: remaining,
    sufficient: compareDecimal(remaining, requested) >= 0,
  });
}
