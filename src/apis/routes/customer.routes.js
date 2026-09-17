import express from "express";
import { requireCustomer } from "../../auth/supabaseAuth.js";
import {
  closeDemoPosition,
  ensureDemoAccount,
  getCustomerWorkspace,
  listCustomerAccounts,
  placeDemoOrder,
} from "../services/customer.service.js";

const router = express.Router();

router.use(requireCustomer);

router.get("/workspace", async (req, res, next) => {
  try {
    const data = await getCustomerWorkspace(req.customer);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get("/accounts", async (req, res, next) => {
  try {
    const data = await listCustomerAccounts(req.customer);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.post("/demo-account", async (req, res, next) => {
  try {
    const data = await ensureDemoAccount(req.customer);
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
});

router.post("/demo-account/:accountId/orders", async (req, res, next) => {
  try {
    const data = await placeDemoOrder(req.customer, req.params.accountId, req.body || {});
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
});

router.post("/demo-account/:accountId/positions/:positionId/close", async (req, res, next) => {
  try {
    const data = await closeDemoPosition(req.customer, req.params.accountId, req.params.positionId, req.body || {});
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

export default router;
