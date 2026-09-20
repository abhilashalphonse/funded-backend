import { Router } from "express";
import Customer from "../../customers/customer.model.js";
import Account from "../../accounts/account.model.js";
import Payment from "../../models/payment.model.js";
import SupportConversation from "../../support/supportConversation.model.js";
import AdminAuditEvent from "../../models/adminAuditEvent.model.js";
import { requireAdmin } from "../../auth/supabaseAuth.js";
import { getFunnelSummary } from "../services/analytics.service.js";
import env from "../../config/env.js";
import boss from "../../config/boss.js";
import { getCustomerOwnershipIds } from "../../customers/customer.service.js";
import { getTradingConnector } from "../../connectors/trading/registry.js";
import { provisionTradingAccount } from "../../connectors/trading/account-provisioning.js";
import { enqueuePaymentActivation } from "../../workers/payment-activation.queue.js";
import { ensureTradingCredential } from "../../trading-credentials/trading-credential.service.js";

const router = Router();
router.use(requireAdmin);

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}

function pageOptions(query) {
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 250);
  return { page, limit, skip: (page - 1) * limit };
}

function customerSearch(q) {
  if (!q) return {};
  const rx = new RegExp(escapeRegex(q), "i");
  return { $or: [{ primaryEmail: rx }, { customerId: rx }] };
}

async function writeAudit(req, event) {
  return AdminAuditEvent.create({
    adminEmail: req.admin.email,
    requestId: req.get("x-request-id") || null,
    ip: req.ip || null,
    ...event,
  });
}

const TRADABLE_ACCOUNT_STATUSES = new Set(["ACTIVE", "PHASE_2", "FUNDED"]);

function platformRecord(account) {
  return (account.platformAccounts || []).find(item =>
    String(item.platformAccountId || "") === String(account.platformAccountId || "")
  ) || null;
}

async function pauseForCustomerBlock(account, reason) {
  if (!account.platformAccountId) return;
  const connector = getTradingConnector(account.platform);
  await connector.pauseAccount({
    externalRef: account.accountId,
    platformAccountId: account.platformAccountId,
    reason,
    cancelPending: true,
  });
  const record = platformRecord(account);
  if (record) record.status = "PAUSED";
  account.enabled = false;
  account.customerAccessBlocked = true;
  await account.save();
}

async function resumeAfterCustomerBlock(account, reason) {
  if (!account.platformAccountId) {
    account.customerAccessBlocked = false;
    await account.save();
    return;
  }
  const connector = getTradingConnector(account.platform);
  await connector.resumeAccount({
    externalRef: account.accountId,
    platformAccountId: account.platformAccountId,
    reason,
  });
  const record = platformRecord(account);
  if (record) record.status = "ACTIVE";
  account.enabled = TRADABLE_ACCOUNT_STATUSES.has(account.status);
  account.customerAccessBlocked = false;
  await account.save();
}

router.get("/me", (req, res) => {
  res.json({ success: true, data: req.admin });
});

router.get("/overview", async (_req, res, next) => {
  try {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    const month = new Date(day.getFullYear(), day.getMonth(), 1);

    const [
      totalUsers,
      newUsersToday,
      activeChallenges,
      activeTrials,
      fundedAccounts,
      breachedToday,
      paidToday,
      paidMonth,
      failedPaymentsToday,
      pendingProvisioning,
      supportEscalated,
      payoutReview,
      funnel,
    ] = await Promise.all([
      Customer.countDocuments({ status: "ACTIVE" }),
      Customer.countDocuments({ createdAt: { $gte: day } }),
      Account.countDocuments({ accountMode: "CHALLENGE", status: { $in: ["ACTIVE", "PHASE_2"] } }),
      Account.countDocuments({ accountMode: "DEMO", status: { $in: ["NEW", "ACTIVE", "PHASE_2"] } }),
      Account.countDocuments({ status: "FUNDED" }),
      Account.countDocuments({ status: "BREACHED", "projections.breachedAt": { $gte: day } }),
      Payment.aggregate([
        { $match: { status: "PAID", paidAt: { $gte: day } } },
        { $group: { _id: null, revenue: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      Payment.aggregate([
        { $match: { status: "PAID", paidAt: { $gte: month } } },
        { $group: { _id: null, revenue: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      Payment.countDocuments({ status: { $in: ["FAILED", "EXPIRED", "UNDERPAID"] }, updatedAt: { $gte: day } }),
      Payment.countDocuments({ status: "PAID", "activation.status": { $in: ["NOT_STARTED", "PENDING", "FAILED"] } }),
      SupportConversation.countDocuments({ status: "ESCALATED" }),
      Account.countDocuments({ status: "FUNDED_REVIEW" }),
      getFunnelSummary({ days: 30 }),
    ]);

    const recentPayments = await Payment.find({}).sort({ createdAt: -1 }).limit(8)
      .select("orderId email amount currency status accountId createdAt paidAt").lean();
    const recentAccounts = await Account.find({}).sort({ updatedAt: -1 }).limit(8)
      .select("accountId customerId accountMode status accountSize currentPhase updatedAt").lean();

    res.json({
      success: true,
      data: {
        kpis: {
          revenueToday: paidToday[0]?.revenue || 0,
          paidChallengesToday: paidToday[0]?.count || 0,
          newUsersToday,
          activeChallenges,
          activeTrials,
          fundedAccounts,
          breachedToday,
          failedPaymentsToday,
          pendingProvisioning,
          supportEscalated,
          payoutReview,
          revenueMonth: paidMonth[0]?.revenue || 0,
          totalUsers,
        },
        funnel,
        recentPayments,
        recentAccounts,
      },
    });
  } catch (error) { next(error); }
});

router.get("/users", async (req, res, next) => {
  try {
    const { page, limit, skip } = pageOptions(req.query);
    const filter = {
      ...customerSearch(req.query.q),
      ...(req.query.status ? { status: String(req.query.status).toUpperCase() } : {}),
    };
    const [customers, total] = await Promise.all([
      Customer.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Customer.countDocuments(filter),
    ]);
    const ids = customers.map(item => item.customerId);
    const [accountStats, paymentStats] = await Promise.all([
      Account.aggregate([
        { $match: { customerId: { $in: ids } } },
        { $group: {
          _id: "$customerId",
          challenges: { $sum: { $cond: [{ $eq: ["$accountMode", "CHALLENGE"] }, 1, 0] } },
          trials: { $sum: { $cond: [{ $eq: ["$accountMode", "DEMO"] }, 1, 0] } },
          funded: { $sum: { $cond: [{ $eq: ["$status", "FUNDED"] }, 1, 0] } },
          active: { $sum: { $cond: [{ $in: ["$status", ["ACTIVE", "PHASE_2"]] }, 1, 0] } },
        } },
      ]),
      Payment.aggregate([
        { $match: { customerId: { $in: ids } } },
        { $group: {
          _id: "$customerId",
          orders: { $sum: 1 },
          paidOrders: { $sum: { $cond: [{ $eq: ["$status", "PAID"] }, 1, 0] } },
          spend: { $sum: { $cond: [{ $eq: ["$status", "PAID"] }, "$amount", 0] } },
        } },
      ]),
    ]);
    const accountMap = new Map(accountStats.map(item => [item._id, item]));
    const paymentMap = new Map(paymentStats.map(item => [item._id, item]));

    res.json({
      success: true,
      data: {
        rows: customers.map(customer => ({
          ...customer,
          stats: {
            challenges: accountMap.get(customer.customerId)?.challenges || 0,
            trials: accountMap.get(customer.customerId)?.trials || 0,
            funded: accountMap.get(customer.customerId)?.funded || 0,
            active: accountMap.get(customer.customerId)?.active || 0,
            orders: paymentMap.get(customer.customerId)?.orders || 0,
            paidOrders: paymentMap.get(customer.customerId)?.paidOrders || 0,
            totalSpend: paymentMap.get(customer.customerId)?.spend || 0,
          },
        })),
        pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
      },
    });
  } catch (error) { next(error); }
});

router.get("/users/:customerId", async (req, res, next) => {
  try {
    const customer = await Customer.findOne({ customerId: req.params.customerId }).lean();
    if (!customer) return res.status(404).json({ success: false, message: "Customer not found." });
    const [accounts, payments, support] = await Promise.all([
      Account.find({ customerId: customer.customerId }).sort({ createdAt: -1 }).lean(),
      Payment.find({ customerId: customer.customerId }).sort({ createdAt: -1 }).lean(),
      SupportConversation.find({ customerId: customer.customerId }).sort({ lastMessageAt: -1 }).limit(20).lean(),
    ]);
    const spend = payments.filter(item => item.status === "PAID").reduce((sum, item) => sum + Number(item.amount || 0), 0);
    res.json({ success: true, data: { customer, accounts, payments, support, stats: { totalSpend: spend, accounts: accounts.length, orders: payments.length } } });
  } catch (error) { next(error); }
});

router.post("/users/:customerId/status", async (req, res, next) => {
  try {
    const status = String(req.body?.status || "").toUpperCase();
    const reason = String(req.body?.reason || "").trim();
    if (!["ACTIVE", "BLOCKED"].includes(status)) return res.status(400).json({ success: false, message: "status must be ACTIVE or BLOCKED." });
    if (!reason) return res.status(400).json({ success: false, message: "A reason is required." });
    const customer = await Customer.findOne({ customerId: req.params.customerId });
    if (!customer) return res.status(404).json({ success: false, message: "Customer not found." });
    if (customer.status === "MERGED") return res.status(409).json({ success: false, message: "Merged customer records cannot be modified." });

    const before = { status: customer.status };
    const ownershipIds = await getCustomerOwnershipIds(customer);
    customer.status = status;
    await customer.save();

    const platformErrors = [];
    if (status === "BLOCKED") {
      const accounts = await Account.find({
        customerId: { $in: ownershipIds },
        status: { $in: [...TRADABLE_ACCOUNT_STATUSES] },
        enabled: true,
        customerAccessBlocked: { $ne: true },
      });
      for (const account of accounts) {
        try {
          await pauseForCustomerBlock(account, "ACG_FUNDED_CUSTOMER_BLOCKED");
        } catch (error) {
          platformErrors.push({ accountId: account.accountId, message: String(error?.message || error) });
        }
      }
    } else {
      const accounts = await Account.find({
        customerId: { $in: ownershipIds },
        customerAccessBlocked: true,
      });
      for (const account of accounts) {
        try {
          await resumeAfterCustomerBlock(account, "ACG_FUNDED_CUSTOMER_REACTIVATED");
        } catch (error) {
          platformErrors.push({ accountId: account.accountId, message: String(error?.message || error) });
        }
      }
    }

    await writeAudit(req, {
      action: "CUSTOMER_STATUS_CHANGED",
      entityType: "CUSTOMER",
      entityId: customer.customerId,
      reason,
      before,
      after: { status, platformErrors },
    });

    if (platformErrors.length) {
      return res.status(502).json({
        success: false,
        message: status === "BLOCKED"
          ? "Customer was blocked, but one or more trading accounts could not be paused. Retry the block action after ACG Trader recovers."
          : "Customer was reactivated, but one or more trading accounts could not be resumed.",
        code: "TRADING_PLATFORM_CONTROL_PARTIAL_FAILURE",
        data: { customer, platformErrors },
      });
    }

    res.json({ success: true, data: customer });
  } catch (error) { next(error); }
});

router.get("/challenges", async (req, res, next) => {
  try {
    const { page, limit, skip } = pageOptions(req.query);
    const q = String(req.query.q || "").trim();
    const filter = {
      accountMode: String(req.query.mode || "CHALLENGE").toUpperCase() === "DEMO" ? "DEMO" : "CHALLENGE",
      ...(req.query.status ? { status: String(req.query.status).toUpperCase() } : {}),
      ...(req.query.platform ? { platform: req.query.platform } : {}),
    };
    if (req.query.funded === "true") {
      delete filter.accountMode;
      filter.status = { $in: ["FUNDED_REVIEW", "FUNDED"] };
    }
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ accountId: rx }, { customerId: rx }, { ownerExternalRef: rx }, { platformAccountId: rx }];
    }
    const [rows, total] = await Promise.all([
      Account.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Account.countDocuments(filter),
    ]);
    res.json({ success: true, data: { rows, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } } });
  } catch (error) { next(error); }
});

router.get("/challenges/:accountId", async (req, res, next) => {
  try {
    const account = await Account.findOne({ accountId: req.params.accountId }).lean();
    if (!account) return res.status(404).json({ success: false, message: "Challenge not found." });
    const customer = account.customerId ? await Customer.findOne({ customerId: account.customerId }).lean() : null;
    const payment = await Payment.findOne({ accountId: account.accountId }).lean();
    res.json({ success: true, data: { account, customer, payment } });
  } catch (error) { next(error); }
});

router.post("/challenges/:accountId/action", async (req, res, next) => {
  try {
    const action = String(req.body?.action || "").toUpperCase();
    const reason = String(req.body?.reason || "").trim();
    if (!["LOCK", "UNLOCK", "CLOSE", "APPROVE_FUNDED"].includes(action)) return res.status(400).json({ success: false, message: "Unsupported challenge action." });
    if (!reason) return res.status(400).json({ success: false, message: "A reason is required." });
    const account = await Account.findOne({ accountId: req.params.accountId });
    if (!account) return res.status(404).json({ success: false, message: "Challenge not found." });
    const before = { status: account.status, enabled: account.enabled, platformAccountId: account.platformAccountId };
    const connector = getTradingConnector(account.platform);

    if (action === "LOCK") {
      if (!TRADABLE_ACCOUNT_STATUSES.has(account.status)) {
        return res.status(409).json({ success: false, message: "Only active, Phase 2, or funded accounts can be manually locked." });
      }
      if (!account.platformAccountId) return res.status(409).json({ success: false, message: "Trading platform account is not provisioned." });
      await connector.pauseAccount({ externalRef: account.accountId, platformAccountId: account.platformAccountId, reason: `ACG_FUNDED_ADMIN_LOCK: ${reason}`, cancelPending: true });
      const record = platformRecord(account);
      if (record) record.status = "PAUSED";
      account.statusBeforeLock = account.status;
      account.status = "LOCKED";
      account.enabled = false;
    }

    if (action === "UNLOCK") {
      if (account.status !== "LOCKED") return res.status(409).json({ success: false, message: "Only locked accounts can be unlocked." });
      const customer = account.customerId ? await Customer.findOne({ customerId: account.customerId }).lean() : null;
      if (customer?.status === "BLOCKED") return res.status(409).json({ success: false, message: "Reactivate the customer before unlocking this trading account." });
      if (!account.platformAccountId) return res.status(409).json({ success: false, message: "Trading platform account is not provisioned." });
      await connector.resumeAccount({ externalRef: account.accountId, platformAccountId: account.platformAccountId, reason: `ACG_FUNDED_ADMIN_UNLOCK: ${reason}` });
      const record = platformRecord(account);
      if (record) record.status = "ACTIVE";
      account.status = TRADABLE_ACCOUNT_STATUSES.has(account.statusBeforeLock) ? account.statusBeforeLock : "ACTIVE";
      account.statusBeforeLock = null;
      account.enabled = true;
    }

    if (action === "CLOSE") {
      if (account.status === "CLOSED") return res.status(409).json({ success: false, message: "Account is already closed." });
      if (account.platformAccountId) {
        await connector.closeAccount({ externalRef: account.accountId, platformAccountId: account.platformAccountId, reason: `ACG_FUNDED_ADMIN_CLOSE: ${reason}`, liquidate: true });
        const record = platformRecord(account);
        if (record) record.status = "CLOSED";
      }
      account.status = "CLOSED";
      account.statusBeforeLock = null;
      account.enabled = false;
    }

    if (action === "APPROVE_FUNDED") {
      if (account.status !== "FUNDED_REVIEW") return res.status(409).json({ success: false, message: "Only accounts in funded review can be approved." });
      const customer = account.customerId ? await Customer.findOne({ customerId: account.customerId }).lean() : null;
      if (customer?.status === "BLOCKED") return res.status(409).json({ success: false, message: "Blocked customers cannot be approved for a funded account." });
      await provisionTradingAccount(account, { phase: Number(account.currentPhase || 1), accountType: "FUNDED" });
      await ensureTradingCredential(account, { queueEmail: true });
      account.status = "FUNDED";
      account.enabled = true;
      account.fundedApprovedAt = new Date();
    }

    await account.save();
    await writeAudit(req, {
      action: "CHALLENGE_" + action,
      entityType: "ACCOUNT",
      entityId: account.accountId,
      reason,
      before,
      after: { status: account.status, enabled: account.enabled, platformAccountId: account.platformAccountId, fundedApprovedAt: account.fundedApprovedAt || null },
    });
    res.json({ success: true, data: account });
  } catch (error) { next(error); }
});

async function listPayments(req, res, next) {
  try {
    const { page, limit, skip } = pageOptions(req.query);
    const q = String(req.query.q || "").trim();
    const filter = {
      ...(req.query.status ? { status: String(req.query.status).toUpperCase() } : {}),
      ...(req.query.method ? { paymentMethod: String(req.query.method).toUpperCase() } : {}),
    };
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ orderId: rx }, { email: rx }, { customerId: rx }, { providerPaymentId: rx }, { accountId: rx }];
    }
    const [rows, total] = await Promise.all([
      Payment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Payment.countDocuments(filter),
    ]);
    res.json({ success: true, data: { rows, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } } });
  } catch (error) { next(error); }
}

router.get("/orders", listPayments);
router.get("/payments", listPayments);

router.post("/payments/:paymentId/retry-activation", async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ success: false, message: "A reason is required." });
    const payment = await Payment.findById(req.params.paymentId);
    if (!payment) return res.status(404).json({ success: false, message: "Payment not found." });
    if (payment.status !== "PAID") return res.status(409).json({ success: false, message: "Only paid payments can retry account activation." });
    if (payment.accountId || payment.activation?.status === "ACTIVE") return res.status(409).json({ success: false, message: "This payment is already activated." });
    if (payment.activation?.status === "PENDING") {
      const attemptedAt = payment.activation?.attemptedAt ? new Date(payment.activation.attemptedAt).getTime() : Date.now();
      if (Date.now() - attemptedAt < 5 * 60 * 1000) return res.status(409).json({ success: false, message: "Activation is still in progress. Retry only if it remains pending for more than five minutes." });
    }
    await Payment.updateOne({ _id: payment._id }, { $set: { "activation.status": "FAILED", "activation.error": "Manual retry requested by admin." } });
    const jobId = await enqueuePaymentActivation(boss, payment._id);
    await writeAudit(req, {
      action: "PAYMENT_ACTIVATION_RETRY",
      entityType: "PAYMENT",
      entityId: String(payment._id),
      reason,
      before: { activation: payment.activation },
      after: { queued: true, jobId },
    });
    res.status(202).json({ success: true, data: { paymentId: payment._id, jobId } });
  } catch (error) { next(error); }
});

router.get("/support", async (req, res, next) => {
  try {
    const { page, limit, skip } = pageOptions(req.query);
    const filter = req.query.status ? { status: String(req.query.status).toUpperCase() } : {};
    const [rows, total] = await Promise.all([
      SupportConversation.find(filter).sort({ lastMessageAt: -1 }).skip(skip).limit(limit).lean(),
      SupportConversation.countDocuments(filter),
    ]);
    res.json({ success: true, data: { rows, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } } });
  } catch (error) { next(error); }
});

router.get("/funnel", async (req, res, next) => {
  try {
    const data = await getFunnelSummary({ days: req.query.days });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get("/risk", async (_req, res, next) => {
  try {
    const [breached, locked, fundedReview, failedProvisioning] = await Promise.all([
      Account.find({ status: "BREACHED" }).sort({ updatedAt: -1 }).limit(100).lean(),
      Account.find({ status: "LOCKED" }).sort({ updatedAt: -1 }).limit(100).lean(),
      Account.find({ status: "FUNDED_REVIEW" }).sort({ updatedAt: -1 }).limit(100).lean(),
      Account.find({ "provisioning.status": "FAILED" }).sort({ updatedAt: -1 }).limit(100).lean(),
    ]);
    res.json({ success: true, data: { breached, locked, fundedReview, failedProvisioning } });
  } catch (error) { next(error); }
});

router.get("/audit", async (req, res, next) => {
  try {
    const { page, limit, skip } = pageOptions(req.query);
    const filter = {
      ...(req.query.action ? { action: req.query.action } : {}),
      ...(req.query.entityType ? { entityType: req.query.entityType } : {}),
    };
    const [rows, total] = await Promise.all([
      AdminAuditEvent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AdminAuditEvent.countDocuments(filter),
    ]);
    res.json({ success: true, data: { rows, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } } });
  } catch (error) { next(error); }
});

router.get("/admin-users", async (req, res) => {
  res.json({
    success: true,
    data: {
      rows: env.ADMIN_EMAILS.map(email => ({ email, role: "SUPER_ADMIN", source: "ADMIN_EMAILS", current: email === req.admin.email })),
      note: "Admin identities are currently controlled by the ADMIN_EMAILS deployment allowlist.",
    },
  });
});

router.get("/system", async (_req, res) => {
  res.json({
    success: true,
    data: {
      services: [
        { name: "ACG Funded API", status: "HEALTHY" },
        { name: "Customer authentication", status: env.SUPABASE_URL && env.SUPABASE_ANON_KEY ? "HEALTHY" : "NOT_CONFIGURED" },
        { name: "ACG Trader", status: env.TRADING_PROVIDER === "acg-trader" && env.ACG_TRADER_BASE_URL ? "CONFIGURED" : "DEVELOPMENT" },
        { name: "Payments", status: env.NOWPAYMENTS_API_KEY ? "CONFIGURED" : "NOT_CONFIGURED" },
        { name: "Support AI", status: env.OPENAI_API_KEY ? "CONFIGURED" : "NOT_CONFIGURED" },
      ],
      tradingProvider: env.TRADING_PROVIDER,
      environment: env.NODE_ENV,
      capabilities: {
        payouts: false,
        refunds: false,
        challengeProductAdmin: false,
        pricingAdmin: false,
        affiliates: false,
      },
    },
  });
});

export default router;
