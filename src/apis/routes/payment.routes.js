import { Router } from "express";
import { optionalCustomer } from "../../auth/supabaseAuth.js";
import { createCrypto, ipn, status } from "../controllers/payment.controller.js";

const router = Router();
router.post("/crypto/create", optionalCustomer, createCrypto);
router.post("/crypto/ipn", ipn);
router.get("/:paymentId/status", status);
export default router;
