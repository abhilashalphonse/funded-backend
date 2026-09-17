import express from "express";
import { requireCustomer } from "../../auth/supabaseAuth.js";
import { ensureDemoAccount, getCustomerWorkspace, listCustomerAccounts } from "../services/customer.service.js";

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

export default router;
