import Account from "../../accounts/account.model.js";

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
  // projection rather than floating equity/P&L for payout previews.
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

export function buildPayoutOverview(account) {
  const stage = accountStage(account);
  const mode = payoutMode(stage);
  const realized = realizedProfitUsd(account);
  const split = profitSplitPercent(account);
  const estimatedShare = split == null ? null : money2(realized * split / 100);

  const blockers = [];
  if (stage !== "MASTER") blockers.push("MASTER_ACCOUNT_REQUIRED");
  if (split == null) blockers.push("PROFIT_SPLIT_UNAVAILABLE");
  if (realized <= 0) blockers.push("NO_REALIZED_PROFIT");
  if (stage === "MASTER") blockers.push("PAYOUT_REQUEST_FLOW_NOT_ENABLED");

  return {
    accountId: account?.accountId || null,
    accountStage: stage,
    accountStatus: String(account?.status || "").toUpperCase() || null,
    mode,
    asOf: account?.lastPlatformSnapshotAt || account?.updatedAt || null,
    commercialTerms: {
      profitSplitPercent: split,
      payoutFrequency: account?.commercialTerms?.payoutFrequency || null,
    },
    performance: {
      realizedProfitUsd: realized,
      estimatedTraderShareUsd: estimatedShare,
      source: "REALIZED_BALANCE_PROJECTION",
    },
    eligibility: {
      canRequest: false,
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

export async function getCustomerPayoutOverview(
  customer,
  accountId,
  { accountModel = Account } = {},
) {
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

  return buildPayoutOverview(account);
}
