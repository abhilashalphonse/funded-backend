import { Router } from "express";
import { requireAdmin } from "../auth/adminAuth.js";
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
  getOperationsStatus,
} from "./admin.service.js";

const router = Router();
router.use(requireAdmin);

router.get("/overview", async (_req, res, next) => {
  try {
    res.json({ success: true, data: await getAdminOverview() });
  } catch (error) { next(error); }
});

router.get("/users", async (req, res, next) => {
  try {
    res.json({ success: true, data: await listUsers(req.query) });
  } catch (error) { next(error); }
});

router.get("/users/:customerId", async (req, res, next) => {
  try {
    res.json({ success: true, data: await getUserDetail(req.params.customerId) });
  } catch (error) { next(error); }
});

router.patch("/users/:customerId/status", async (req, res, next) => {
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
});

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

router.get("/payments", async (req, res, next) => {
  try {
    res.json({ success: true, data: await listPayments(req.query) });
  } catch (error) { next(error); }
});

router.get("/support", async (req, res, next) => {
  try {
    res.json({ success: true, data: await listSupport(req.query) });
  } catch (error) { next(error); }
});

router.get("/audit", async (req, res, next) => {
  try {
    res.json({ success: true, data: await listAudit(req.query) });
  } catch (error) { next(error); }
});

router.get("/operations", async (_req, res, next) => {
  try {
    res.json({ success: true, data: await getOperationsStatus() });
  } catch (error) { next(error); }
});

export default router;
