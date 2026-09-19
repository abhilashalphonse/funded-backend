import Customer from "../customers/customer.model.js";
import Account from "../accounts/account.model.js";
import Payment from "../models/payment.model.js";
import SupportConversation from "../support/supportConversation.model.js";
import AdminAudit from "./adminAudit.model.js";
import { getFunnelSummary } from "../apis/services/analytics.service.js";

const pageSize = (value) => Math.min(Math.max(Number(value) || 50, 1), 250);
const pageNumber = (value) => Math.max(Number(value) || 1, 1);
const escapeRegex = (value) => String(value || "").replace(/[.*+?^$()|[\]\\]/g, "\\$&");

function publicAccount(account) {
  return {
    accountId: account.accountId,
    customerId: account.customerId || null,
    ownerExternalRef: account.ownerExternalRef || null,
    accountMode: account.accountMode,
    challengeType: account.challengeType,
    accountSize: account.accountSize,
    currentPhase: account.currentPhase,
    balance: account.balance,
    equity: account.equity,
    projections: account.projections,
    rules: account.rules,
    commercialTerms: account.commercialTerms,
    status: account.status,
    enabled: account.enabled,
    platform: account.platform,
    platformAccountId: account.platformAccountId || null,
    provisioning: account.provisioning,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastPlatformSnapshotAt: account.lastPlatformSnapshotAt,
  };
}

function publicPayment(payment) {
  return {
    id: String(payment._id),
    orderId: payment.orderId,
    customerId: payment.customerId || null,
    email: payment.email,
    amount: payment.amount,
    currency: payment.currency,
    paymentMethod: payment.paymentMethod,
    provider: payment.provider,
    providerPaymentId: payment.providerPaymentId || null,
    providerStatus: payment.providerStatus || null,
    status: payment.status,
    accountId: payment.accountId || null,
    activation: payment.activation,
    challengeDefinition: payment.challengeDefinition,
    commercialConfig: payment.commercialConfig,
    metadata: payment.metadata || {},
    paidAt: payment.paidAt || null,
    activatedAt: payment.activatedAt || null,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}

export async function getAdminOverview() {
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const startWeek = new Date(Date.now() - 7 * 86400000);

  const [
    users,
    usersToday,
    paidToday,
    revenueRows,
    activeChallenges,
    activeTrials,
    fundedAccounts,
    breachedToday,
    failedPayments,
    failedProvisioning,
    supportEscalated,
    recentActivity,
    funnel,
  ] = await Promise.all([
    Customer.countDocuments({ status: { $ne: "MERGED" } }),
    Customer.countDocuments({ createdAt: { $gte: startToday }, status: { $ne: "MERGED" } }),
    Payment.countDocuments({ status: "PAID", paidAt: { $gte: startToday } }),
    Payment.aggregate([
      { $match: { status: "PAID", paidAt: { $gte: startToday } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    Account.countDocuments({ accountMode: "CHALLENGE", status: { $in: ["ACTIVE", "PHASE_2"] } }),
    Account.countDocuments({ accountMode: "DEMO", status: { $in: ["ACTIVE", "PHASE_2"] } }),
    Account.countDocuments({ status: "FUNDED" }),
    Account.countDocuments({ status: "BREACHED", "projections.breachedAt": { $gte: startToday } }),
    Payment.countDocuments({ status: { $in: ["FAILED", "UNDERPAID"] }, updatedAt: { $gte: startWeek } }),
    Account.countDocuments({ "provisioning.status": "FAILED" }),
    SupportConversation.countDocuments({ status: "ESCALATED" }),
    AdminAudit.find({}).sort({ createdAt: -1 }).limit(10).lean(),
    getFunnelSummary({ days: 30 }),
  ]);

  return {
    generatedAt: new Date(),
    kpis: {
      users,
      usersToday,
      paidToday,
      revenueToday: Number(revenueRows?.[0]?.total || 0),
      activeChallenges,
      activeTrials,
      fundedAccounts,
      breachedToday,
      failedPayments,
      failedProvisioning,
      supportEscalated,
    },
    funnel,
    recentActivity,
  };
}

export async function listUsers({ search, status, page, limit }) {
  const filter = { status: { $ne: "MERGED" } };
  if (status) filter.status = status;
  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ primaryEmail: regex }, { customerId: regex }];
  }

  const size = pageSize(limit);
  const currentPage = pageNumber(page);
  const [items, total] = await Promise.all([
    Customer.find(filter).sort({ createdAt: -1 }).skip((currentPage - 1) * size).limit(size).lean(),
    Customer.countDocuments(filter),
  ]);

  const ids = items.map((item) => item.customerId);
  const [accounts, payments] = await Promise.all([
    Account.find({ customerId: { $in: ids } }).select("customerId accountMode status").lean(),
    Payment.find({ customerId: { $in: ids } }).select("customerId amount status").lean(),
  ]);

  const accountStats = new Map();
  for (const account of accounts) {
    const row = accountStats.get(account.customerId) || { challenges: 0, activeChallenges: 0, fundedAccounts: 0, freeTrials: 0 };
    if (account.accountMode === "DEMO") row.freeTrials += 1;
    else row.challenges += 1;
    if (account.accountMode === "CHALLENGE" && ["ACTIVE", "PHASE_2"].includes(account.status)) row.activeChallenges += 1;
    if (account.status === "FUNDED") row.fundedAccounts += 1;
    accountStats.set(account.customerId, row);
  }

  const paymentStats = new Map();
  for (const payment of payments) {
    const row = paymentStats.get(payment.customerId) || { totalSpend: 0, paidOrders: 0 };
    if (payment.status === "PAID") {
      row.totalSpend += Number(payment.amount || 0);
      row.paidOrders += 1;
    }
    paymentStats.set(payment.customerId, row);
  }

  return {
    items: items.map((item) => ({
      ...item,
      ...(accountStats.get(item.customerId) || { challenges: 0, activeChallenges: 0, fundedAccounts: 0, freeTrials: 0 }),
      ...(paymentStats.get(item.customerId) || { totalSpend: 0, paidOrders: 0 }),
    })),
    pagination: { page: currentPage, limit: size, total, pages: Math.max(1, Math.ceil(total / size)) },
  };
}

export async function getUserDetail(customerId) {
  const customer = await Customer.findOne({ customerId }).lean();
  if (!customer) {
    const error = new Error("Customer not found.");
    error.status = 404;
    throw error;
  }

  const [accounts, payments, support, audits] = await Promise.all([
    Account.find({ customerId }).sort({ createdAt: -1 }).lean(),
    Payment.find({ customerId }).sort({ createdAt: -1 }).lean(),
    SupportConversation.find({ customerId }).sort({ lastMessageAt: -1 }).limit(20).lean(),
    AdminAudit.find({ entityId: customerId }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);

  const paid = payments.filter((item) => item.status === "PAID");
  return {
    customer,
    kpis: {
      totalSpend: paid.reduce((sum, item) => sum + Number(item.amount || 0), 0),
      paidChallenges: paid.length,
      activeChallenges: accounts.filter((item) => item.accountMode === "CHALLENGE" && ["ACTIVE", "PHASE_2"].includes(item.status)).length,
      freeTrials: accounts.filter((item) => item.accountMode === "DEMO").length,
      fundedAccounts: accounts.filter((item) => item.status === "FUNDED").length,
    },
    accounts: accounts.map(publicAccount),
    payments: payments.map(publicPayment),
    support,
    audits,
  };
}

export async function listAccounts({ search, mode, status, page, limit }) {
  const filter = {};
  if (mode) filter.accountMode = mode;
  if (status) filter.status = status;
  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ accountId: regex }, { customerId: regex }, { ownerExternalRef: regex }, { platformAccountId: regex }];
  }

  const size = pageSize(limit);
  const currentPage = pageNumber(page);
  const [items, total] = await Promise.all([
    Account.find(filter).sort({ createdAt: -1 }).skip((currentPage - 1) * size).limit(size).lean(),
    Account.countDocuments(filter),
  ]);

  return {
    items: items.map(publicAccount),
    pagination: { page: currentPage, limit: size, total, pages: Math.max(1, Math.ceil(total / size)) },
  };
}

export async function getAccountDetail(accountId) {
  const account = await Account.findOne({ accountId }).lean();
  if (!account) {
    const error = new Error("Challenge account not found.");
    error.status = 404;
    throw error;
  }

  const [customer, payment, audits] = await Promise.all([
    account.customerId ? Customer.findOne({ customerId: account.customerId }).lean() : null,
    Payment.findOne({ accountId }).lean(),
    AdminAudit.find({ entityId: accountId }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);

  return {
    account: publicAccount(account),
    customer,
    payment: payment ? publicPayment(payment) : null,
    audits,
  };
}

export async function listPayments({ search, status, page, limit }) {
  const filter = {};
  if (status) filter.status = status;
  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ orderId: regex }, { email: regex }, { customerId: regex }, { accountId: regex }, { providerPaymentId: regex }];
  }

  const size = pageSize(limit);
  const currentPage = pageNumber(page);
  const [items, total] = await Promise.all([
    Payment.find(filter).sort({ createdAt: -1 }).skip((currentPage - 1) * size).limit(size).lean(),
    Payment.countDocuments(filter),
  ]);

  return {
    items: items.map(publicPayment),
    pagination: { page: currentPage, limit: size, total, pages: Math.max(1, Math.ceil(total / size)) },
  };
}

export async function listSupport({ status, page, limit }) {
  const filter = status ? { status } : {};
  const size = pageSize(limit);
  const currentPage = pageNumber(page);
  const [items, total] = await Promise.all([
    SupportConversation.find(filter).sort({ lastMessageAt: -1 }).skip((currentPage - 1) * size).limit(size).lean(),
    SupportConversation.countDocuments(filter),
  ]);

  return {
    items,
    pagination: { page: currentPage, limit: size, total, pages: Math.max(1, Math.ceil(total / size)) },
  };
}

export async function listAudit({ page, limit }) {
  const size = pageSize(limit);
  const currentPage = pageNumber(page);
  const [items, total] = await Promise.all([
    AdminAudit.find({}).sort({ createdAt: -1 }).skip((currentPage - 1) * size).limit(size).lean(),
    AdminAudit.countDocuments({}),
  ]);

  return {
    items,
    pagination: { page: currentPage, limit: size, total, pages: Math.max(1, Math.ceil(total / size)) },
  };
}

export async function setCustomerStatus({ customerId, status, reason, admin, req }) {
  if (!["ACTIVE", "BLOCKED"].includes(status)) {
    const error = new Error("Unsupported customer status.");
    error.status = 400;
    throw error;
  }
  if (!reason?.trim()) {
    const error = new Error("A reason is required.");
    error.status = 400;
    throw error;
  }

  const customer = await Customer.findOne({ customerId });
  if (!customer) {
    const error = new Error("Customer not found.");
    error.status = 404;
    throw error;
  }

  const before = { status: customer.status };
  customer.status = status;
  await customer.save();

  await AdminAudit.create({
    adminUserId: admin.userId,
    adminEmail: admin.email,
    action: status === "BLOCKED" ? "USER_BLOCKED" : "USER_REACTIVATED",
    entityType: "CUSTOMER",
    entityId: customerId,
    reason: reason.trim(),
    before,
    after: { status: customer.status },
    requestId: req.get("x-request-id") || null,
    ip: req.ip || null,
  });

  return customer.toObject();
}

export async function setAccountEnabled({ accountId, enabled, reason, admin, req }) {
  if (!reason?.trim()) {
    const error = new Error("A reason is required.");
    error.status = 400;
    throw error;
  }

  const account = await Account.findOne({ accountId });
  if (!account) {
    const error = new Error("Challenge account not found.");
    error.status = 404;
    throw error;
  }

  const before = { enabled: account.enabled };
  account.enabled = Boolean(enabled);
  await account.save();

  await AdminAudit.create({
    adminUserId: admin.userId,
    adminEmail: admin.email,
    action: enabled ? "CHALLENGE_RESUMED" : "CHALLENGE_PAUSED",
    entityType: "ACCOUNT",
    entityId: accountId,
    reason: reason.trim(),
    before,
    after: { enabled: account.enabled },
    requestId: req.get("x-request-id") || null,
    ip: req.ip || null,
  });

  return publicAccount(account.toObject());
}

export async function getOperationsStatus() {
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
  const [failedProvisioning, staleAccounts, failedPayments] = await Promise.all([
    Account.countDocuments({ "provisioning.status": "FAILED" }),
    Account.countDocuments({
      status: { $in: ["ACTIVE", "PHASE_2", "FUNDED"] },
      lastPlatformSnapshotAt: { $lt: staleBefore },
    }),
    Payment.countDocuments({ status: { $in: ["FAILED", "UNDERPAID"] }, updatedAt: { $gte: new Date(Date.now() - 86400000) } }),
  ]);

  return { failedProvisioning, staleAccounts, failedPayments, generatedAt: new Date() };
}
