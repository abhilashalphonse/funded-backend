import Account from "../../accounts/account.model.js";
import PayoutRequest, { ACTIVE_PAYOUT_STATUSES } from "../../models/payoutRequest.model.js";

export const PAYOUT_METHODS = Object.freeze([
  Object.freeze({
    id: "UPI",
    label: "UPI",
    settlementCurrency: "INR",
    limits: Object.freeze({
      min: 100,
      max: 20000,
      unit: "INR",
    }),
  }),
  Object.freeze({
    id: "BANK",
    label: "Bank Transfer",
    settlementCurrency: "INR",
    limits: null,
  }),
  Object.freeze({
    id: "USDT",
    label: "USDT",
    settlementCurrency: "USDT",
    limits: null,
  }),
]);

const PAID_STATUS = "PAID";
const FIXED_FREQUENCIES = new Set(["Weekly", "Biweekly", "Monthly"]);

function ownerQuery(customer) {
  const customerIds = [...new Set([customer?.customerId, ...(customer?.customerIds || [])].filter(Boolean))];
  const legacyRefs = [...new Set([customer?.id, customer?.email, ...customerIds].filter(Boolean))];

  return {
    $or: [
      { customerId: { $in: customerIds } },
      { ownerExternalRef: { $in: legacyRefs } },
    ],
  };
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function money2(value) {
  return Math.round((finiteNumber(value) + Number.EPSILON) * 100) / 100;
}

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function accountStage(account) {
  if (String(account?.accountMode || "").toUpperCase() === "DEMO") return "TRIAL";

  const status = String(account?.status || "").toUpperCase();
  if (status === "FUNDED") return "MASTER";
  if (["FUNDED_REVIEW", "PASSED"].includes(status)) return "MASTER_REVIEW";
  return "CHALLENGE";
}

function payoutMode(stage) {
  if (stage === "TRIAL") return "PREVIEW";
  if (stage === "MASTER") return "REAL";
  return "JOURNEY";
}

function realizedProfitUsd(account) {
  // Funded projects authoritative ACG Trader snapshots into account.balance and
  // projections.profit = balance - initial balance. Use that realized balance
  // projection rather than floating equity/P&L for payout calculations.
  const projected = Number(account?.projections?.profit);
  if (Number.isFinite(projected)) return money2(Math.max(0, projected));

  const initial = finiteNumber(account?.initialDeposit || account?.accountSize);
  const balance = finiteNumber(account?.balance);
  return money2(Math.max(0, balance - initial));
}

function profitSplitPercent(account) {
  const value = Number(account?.commercialTerms?.profitSplit);
  return Number.isFinite(value) && value > 0 && value <= 100 ? value : null;
}

function normalizePayoutFrequency(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "weekly") return "Weekly";
  if (normalized === "biweekly" || normalized === "bi-weekly") return "Biweekly";
  if (normalized === "monthly") return "Monthly";
  if (normalized === "on demand" || normalized === "ondemand" || normalized === "on-demand") return "On Demand";
  return null;
}

function addDays(date, days) {
  return new Date(date.getTime() + Number(days) * 24 * 60 * 60 * 1000);
}

function addMonthsUtcClamped(date, months) {
  const source = validDate(date);
  if (!source) return null;

  const targetFirst = new Date(Date.UTC(
    source.getUTCFullYear(),
    source.getUTCMonth() + Number(months),
    1,
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  ));
  const lastDay = new Date(Date.UTC(
    targetFirst.getUTCFullYear(),
    targetFirst.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  targetFirst.setUTCDate(Math.min(source.getUTCDate(), lastDay));
  return targetFirst;
}

function wholeMonthlyCycles(anchor, now) {
  const start = validDate(anchor);
  const current = validDate(now);
  if (!start || !current || current < start) return 0;

  let months = (current.getUTCFullYear() - start.getUTCFullYear()) * 12
    + (current.getUTCMonth() - start.getUTCMonth());
  if (months <= 0) return 0;

  const candidate = addMonthsUtcClamped(start, months);
  if (candidate && candidate > current) months -= 1;
  return Math.max(0, months);
}

export function buildPayoutCycle(account, now = new Date()) {
  const stage = accountStage(account);
  const frequency = normalizePayoutFrequency(account?.commercialTerms?.payoutFrequency);
  const anchorAt = validDate(account?.fundedApprovedAt);
  const current = validDate(now) || new Date();

  if (stage !== "MASTER" || !frequency || !anchorAt) {
    return {
      frequency,
      anchorAt,
      currentCycleKey: null,
      currentCycleEligibleAt: null,
      nextCycleAt: null,
      reached: false,
    };
  }

  if (frequency === "On Demand") {
    return {
      frequency,
      anchorAt,
      currentCycleKey: "ON_DEMAND",
      currentCycleEligibleAt: anchorAt,
      nextCycleAt: null,
      reached: current >= anchorAt,
    };
  }

  if (frequency === "Weekly" || frequency === "Biweekly") {
    const periodDays = frequency === "Weekly" ? 7 : 14;
    const periodMs = periodDays * 24 * 60 * 60 * 1000;
    const elapsedMs = current.getTime() - anchorAt.getTime();
    const cycleIndex = elapsedMs >= periodMs ? Math.floor(elapsedMs / periodMs) : 0;
    const firstEligibleAt = addDays(anchorAt, periodDays);

    if (cycleIndex < 1) {
      return {
        frequency,
        anchorAt,
        currentCycleKey: null,
        currentCycleEligibleAt: firstEligibleAt,
        nextCycleAt: firstEligibleAt,
        reached: false,
      };
    }

    return {
      frequency,
      anchorAt,
      currentCycleKey: `${frequency.toUpperCase()}:${cycleIndex}`,
      currentCycleEligibleAt: addDays(anchorAt, cycleIndex * periodDays),
      nextCycleAt: addDays(anchorAt, (cycleIndex + 1) * periodDays),
      reached: true,
    };
  }

  const cycleIndex = wholeMonthlyCycles(anchorAt, current);
  const firstEligibleAt = addMonthsUtcClamped(anchorAt, 1);
  if (cycleIndex < 1) {
    return {
      frequency,
      anchorAt,
      currentCycleKey: null,
      currentCycleEligibleAt: firstEligibleAt,
      nextCycleAt: firstEligibleAt,
      reached: false,
    };
  }

  return {
    frequency,
    anchorAt,
    currentCycleKey: `MONTHLY:${cycleIndex}`,
    currentCycleEligibleAt: addMonthsUtcClamped(anchorAt, cycleIndex),
    nextCycleAt: addMonthsUtcClamped(anchorAt, cycleIndex + 1),
    reached: true,
  };
}

function plainPayout(record) {
  if (!record) return null;
  if (typeof record.toObject === "function") return record.toObject();
  return record;
}

function summarizePayoutLedger(records = [], cycle = null) {
  let paidUsd = 0;
  let activeReservedUsd = 0;
  let payoutCount = 0;
  let largestPayoutUsd = 0;
  let activePayout = null;
  let currentCyclePaid = false;

  for (const raw of records) {
    const record = plainPayout(raw) || {};
    const status = String(record.status || "").toUpperCase();
    const amount = money2(Math.max(0, finiteNumber(record.requestedAmountUsd)));

    if (status === PAID_STATUS) {
      paidUsd = money2(paidUsd + amount);
      payoutCount += 1;
      largestPayoutUsd = Math.max(largestPayoutUsd, amount);
      if (cycle?.currentCycleKey && record?.cycle?.key === cycle.currentCycleKey) {
        currentCyclePaid = true;
      }
    }

    if (ACTIVE_PAYOUT_STATUSES.includes(status)) {
      activeReservedUsd = money2(activeReservedUsd + amount);
      if (!activePayout) activePayout = record;
    }
  }

  return {
    paidUsd,
    activeReservedUsd,
    payoutCount,
    largestPayoutUsd: money2(largestPayoutUsd),
    activePayout,
    currentCyclePaid,
  };
}

function serializePayoutRecord(raw) {
  const record = plainPayout(raw) || {};
  return {
    payoutId: record.payoutId || null,
    accountId: record.accountId || null,
    status: record.status || null,
    requestedAmountUsd: money2(record.requestedAmountUsd),
    method: record.method || null,
    settlementCurrency: record.settlementCurrency || null,
    settlementAmount: record.settlementAmount == null ? null : money2(record.settlementAmount),
    cycle: record.cycle ? {
      key: record.cycle.key || null,
      frequency: record.cycle.frequency || null,
      eligibleAt: record.cycle.eligibleAt || null,
    } : null,
    requestedAt: record.requestedAt || record.createdAt || null,
    approvedAt: record.approvedAt || null,
    processingAt: record.processingAt || null,
    sentAt: record.sentAt || null,
    paidAt: record.paidAt || null,
    failure: record.failure?.code ? {
      code: record.failure.code,
      message: record.failure.message || null,
    } : null,
  };
}

export function buildPayoutOverview(account, records = [], now = new Date()) {
  const stage = accountStage(account);
  const mode = payoutMode(stage);
  const realized = realizedProfitUsd(account);
  const split = profitSplitPercent(account);
  const estimatedShare = split == null ? null : money2(realized * split / 100);
  const cycle = buildPayoutCycle(account, now);
  const ledger = summarizePayoutLedger(records, cycle);

  const entitlement = estimatedShare == null ? 0 : estimatedShare;
  const availableUsd = money2(Math.max(0, entitlement - ledger.paidUsd - ledger.activeReservedUsd));

  const blockers = [];
  if (stage !== "MASTER") blockers.push("MASTER_ACCOUNT_REQUIRED");
  if (split == null) blockers.push("PROFIT_SPLIT_UNAVAILABLE");
  if (realized <= 0) blockers.push("NO_REALIZED_PROFIT");

  if (stage === "MASTER") {
    if (account?.enabled === false) blockers.push("ACCOUNT_NOT_ACTIVE");
    if (account?.customerAccessBlocked === true) blockers.push("CUSTOMER_ACCESS_BLOCKED");
    if (!cycle.frequency) blockers.push("PAYOUT_FREQUENCY_UNAVAILABLE");
    if (!cycle.anchorAt) blockers.push("MASTER_ACTIVATION_DATE_UNAVAILABLE");
    if (cycle.frequency && cycle.anchorAt && !cycle.reached) blockers.push("PAYOUT_CYCLE_NOT_REACHED");
    if (ledger.activePayout) blockers.push("PAYOUT_ALREADY_IN_PROGRESS");
    if (
      FIXED_FREQUENCIES.has(cycle.frequency)
      && cycle.currentCycleKey
      && ledger.currentCyclePaid
    ) {
      blockers.push("PAYOUT_CYCLE_ALREADY_USED");
    }
    if (availableUsd <= 0) blockers.push("NO_AVAILABLE_PAYOUT");
  }

  const canRequest = stage === "MASTER" && blockers.length === 0;
  const nextEligibleAt = (() => {
    if (!cycle.frequency || !cycle.anchorAt) return null;
    if (!cycle.reached) return cycle.currentCycleEligibleAt;
    if (
      FIXED_FREQUENCIES.has(cycle.frequency)
      && cycle.currentCycleKey
      && ledger.currentCyclePaid
    ) return cycle.nextCycleAt;
    return cycle.currentCycleEligibleAt;
  })();

  return {
    accountId: account?.accountId || null,
    accountStage: stage,
    accountStatus: String(account?.status || "").toUpperCase() || null,
    mode,
    asOf: account?.lastPlatformSnapshotAt || account?.updatedAt || null,
    commercialTerms: {
      profitSplitPercent: split,
      payoutFrequency: cycle.frequency || account?.commercialTerms?.payoutFrequency || null,
    },
    performance: {
      realizedProfitUsd: realized,
      estimatedTraderShareUsd: estimatedShare,
      source: "REALIZED_BALANCE_PROJECTION",
    },
    ledger: {
      lifetimePaidUsd: ledger.paidUsd,
      activeReservedUsd: ledger.activeReservedUsd,
      availableUsd,
      payoutCount: ledger.payoutCount,
      largestPayoutUsd: ledger.largestPayoutUsd,
      activePayout: serializePayoutRecord(ledger.activePayout),
    },
    cycle: {
      frequency: cycle.frequency,
      anchorAt: cycle.anchorAt,
      currentCycleKey: cycle.currentCycleKey,
      currentCycleEligibleAt: cycle.currentCycleEligibleAt,
      nextCycleAt: cycle.nextCycleAt,
      nextEligibleAt,
      reached: cycle.reached,
    },
    eligibility: {
      canRequest,
      blockers,
    },
    methods: PAYOUT_METHODS.map(method => ({
      id: method.id,
      label: method.label,
      settlementCurrency: method.settlementCurrency,
      limits: method.limits ? { ...method.limits } : null,
    })),
  };
}

async function findOwnedAccount(customer, accountId, accountModel) {
  const normalizedAccountId = String(accountId || "").trim();
  if (!normalizedAccountId) {
    const error = new Error("Trading account is required.");
    error.status = 400;
    error.code = "PAYOUT_ACCOUNT_REQUIRED";
    throw error;
  }

  const account = await accountModel.findOne({
    accountId: normalizedAccountId,
    ...ownerQuery(customer),
  });

  if (!account) {
    const error = new Error("Trading account not found.");
    error.status = 404;
    error.code = "PAYOUT_ACCOUNT_NOT_FOUND";
    throw error;
  }

  return account;
}

async function findPayoutRecords(payoutModel, accountId, limit = 100) {
  let query = payoutModel.find({ accountId: String(accountId) });
  if (typeof query?.sort === "function") query = query.sort({ createdAt: -1 });
  if (typeof query?.limit === "function") query = query.limit(limit);
  if (typeof query?.lean === "function") query = query.lean();
  const records = await query;
  return Array.isArray(records) ? records : [];
}

export async function getCustomerPayoutOverview(
  customer,
  accountId,
  {
    accountModel = Account,
    payoutModel = PayoutRequest,
    now = () => new Date(),
  } = {},
) {
  const account = await findOwnedAccount(customer, accountId, accountModel);
  const records = await findPayoutRecords(payoutModel, account.accountId);
  return buildPayoutOverview(account, records, now());
}

export async function getCustomerPayoutHistory(
  customer,
  accountId,
  {
    accountModel = Account,
    payoutModel = PayoutRequest,
  } = {},
) {
  const account = await findOwnedAccount(customer, accountId, accountModel);
  const records = await findPayoutRecords(payoutModel, account.accountId);
  return {
    accountId: account.accountId,
    items: records.map(serializePayoutRecord),
  };
}
