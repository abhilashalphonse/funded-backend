import { Router } from "express";
import { requireAdmin } from "../auth/adminAuth.js";
import Account from "../accounts/account.model.js";
import Payment from "../models/payment.model.js";
import env from "../config/env.js";
import { getFunnelSummary } from "../apis/services/analytics.service.js";
import {
  getAdminOverview,
  getUserDetail,
  listUsers,
  getAccountDetail,
  listAccounts,
  listPayments,
  listSupport,
  listAudit,
  setCustomerStatus,
  setAccountEnabled,
  setAccountState,
  getOperationsStatus,
} from "./admin.service.js";

const router = Router();
router.use(requireAdmin);

const rowsResult = (result) => ({
  rows: result.items || [],
  pagination: result.pagination,
});

router.get("/overview", async (_req, res, next) => {
  try {
    const [overview, recentPayments, recentAccounts] = await Promise.all([
      getAdminOverview(),
      Payment.find({}).sort({ createdAt: -1 }).limit(8).lean(),
      Account.find({}).sort({ createdAt: -1 }).limit(8).lean(),
    ]);
    const k = overview.kpis || {};
    res.json({
      success: true,
      data: {
        kpis: {
          revenueToday: k.revenueToday || 0,
          paidChallengesToday: k.paidToday || 0,
          newUsersToday: k.usersToday || 0,
          totalUsers: k.users || 0,
          activeChallenges: k.activeChallenges || 0,
          activeTrials: k.activeTrials || 0,
          fundedAccounts: k.fundedAccounts || 0,
          payoutReview: await Account.countDocuments({ status: "FUNDED_REVIEW" }),
          breachedToday: k.breachedToday || 0,
          pendingProvisioning: await Account.countDocuments({ "provisioning.status": { $in: ["PENDING", "FAILED"] } }),
          failedPaymentsToday: k.failedPayments || 0,
          supportEscalated: k.supportEscalated || 0,
        },
        funnel: overview.funnel,
        recentPayments,
        recentAccounts,
      },
    });
  } catch (error) { next(error); }
});

router.get("/users", async (req, res, next) => {
  try {
    const result = await listUsers({
      search: req.query.q || req.query.search,
      status: req.query.status,
      page: req.query.page,
      limit: req.query.limit,
    });
    const rows = result.items.map((item) => ({
      ...item,
      stats: {
        challenges: item.challenges || 0,
        trials: item.freeTrials || 0,
        funded: item.fundedAccounts || 0,
        totalSpend: item.totalSpend || 0,
      },
    }));
    res.json({ success: true, data: { rows, pagination: result.pagination } });
  } catch (error) { next(error); }
});

router.get("/users/:customerId", async (req, res, next) => {
  try {
    const detail = await getUserDetail(req.params.customerId);
    res.json({
      success: true,
      data: {
        ...detail,
        stats: {
          totalSpend: detail.kpis?.totalSpend || 0,
          accounts: detail.accounts?.length || 0,
          orders: detail.payments?.length || 0,
        },
      },
    });
  } catch (error) { next(error); }
});

async function updateUserStatus(req, res, next) {
  try {
    const data = await setCustomerStatus({
      customerId: req.params.customerId,
      status: req.body?.status,
      reason: req.body?.reason,
      admin: req.admin,
      req,
    });
    res.json({ success: true, data });
  } catch (error) { next(error); }
}
router.patch("/users/:customerId/status", updateUserStatus);
router.post("/users/:customerId/status", updateUserStatus);

router.get("/accounts", async (req, res, next) => {
  try {
    res.json({ success: true, data: await listAccounts(req.query) });
  } catch (error) { next(error); }
});

router.get("/accounts/:accountId", async (req, res, next) => {
  try {
    res.json({ success: true, data: await getAccountDetail(req.params.accountId) });
  } catch (error) { next(error); }
});

router.patch("/accounts/:accountId/enabled", async (req, res, next) => {
  try {
    const data = await setAccountEnabled({
      accountId: req.params.accountId,
      enabled: req.body?.enabled,
      reason: req.body?.reason,
      admin: req.admin,
      req,
    });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get("/challenges", async (req, res, next) => {
  try {
    let status = req.query.status;
    if (String(req.query.funded || "") === "true") status = "FUNDED";
    const result = await listAccounts({
      search: req.query.q || req.query.search,
      mode: req.query.mode || (req.query.funded ? undefined : "CHALLENGE"),
      status,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json({ success: true, data: rowsResult(result) });
  } catch (error) { next(error); }
});

router.get("/challenges/:accountId", async (req, res, next) => {
  try {
    res.json({ success: true, data: await getAccountDetail(req.params.accountId) });
  } catch (error) { next(error); }
});

router.post("/challenges/:accountId/action", async (req, res, next) => {
  try {
    const data = await setAccountState({
      accountId: req.params.accountId,
      action: req.body?.action,
      reason: req.body?.reason,
      admin: req.admin,
      req,
    });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

async function paymentList(req, res, next) {
  try {
    const result = await listPayments({
      search: req.query.q || req.query.search,
      status: req.query.status,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json({ success: true, data: rowsResult(result) });
  } catch (error) { next(error); }
}
router.get("/orders", paymentList);
router.get("/payments", paymentList);

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

router.get("/funnel", async (req, res, next) => {
  try {
    res.json({ success: true, data: await getFunnelSummary({ days: req.query.days }) });
  } catch (error) { next(error); }
});

router.get("/support", async (req, res, next) => {
  try {
    const result = await listSupport(req.query);
    res.json({ success: true, data: rowsResult(result) });
  } catch (error) { next(error); }
});

router.get("/audit", async (req, res, next) => {
  try {
    const result = await listAudit(req.query);
    res.json({ success: true, data: rowsResult(result) });
  } catch (error) { next(error); }
});

router.get("/operations", async (_req, res, next) => {
  try {
    res.json({ success: true, data: await getOperationsStatus() });
  } catch (error) { next(error); }
});

router.get("/system", async (_req, res, next) => {
  try {
    const operations = await getOperationsStatus();
    res.json({
      success: true,
      data: {
        environment: env.NODE_ENV,
        tradingProvider: env.TRADING_PROVIDER,
        services: [
          { name: "ACG Funded API", status: "HEALTHY" },
          { name: "ACG Trader", status: env.ACG_TRADER_BASE_URL ? "CONFIGURED" : "NOT_CONFIGURED" },
          { name: "Supabase Auth", status: env.SUPABASE_URL ? "CONFIGURED" : "NOT_CONFIGURED" },
          { name: "Payments", status: env.NOWPAYMENTS_API_KEY ? "CONFIGURED" : "NOT_CONFIGURED" },
          { name: "Support AI", status: env.OPENAI_API_KEY ? "CONFIGURED" : "NOT_CONFIGURED" },
        ],
        operations,
        capabilities: {
          payouts: false,
          refunds: false,
          challengeProductAdmin: false,
          pricingAdmin: false,
          affiliates: false,
        },
      },
    });
  } catch (error) { next(error); }
});

router.get("/admin-users", async (req, res) => {
  res.json({
    success: true,
    data: {
      rows: env.ADMIN_EMAILS.map((email) => ({
        email,
        role: "SUPER_ADMIN",
        source: "ADMIN_EMAILS",
        current: email === req.admin.email,
      })),
      note: "Admin access is allowlisted by ADMIN_EMAILS. Role-based permissions can replace this bootstrap model when multiple operators are added.",
    },
  });
});

export default router;
