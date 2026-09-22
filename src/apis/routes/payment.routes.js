import { Router } from "express";
import { optionalCustomer } from "../../auth/supabaseAuth.js";
import { createCrypto, createUpi, ipn, rupayexCallback, status, upiQuote } from "../controllers/payment.controller.js";

const router = Router();
router.post("/crypto/create", optionalCustomer, createCrypto);
router.post("/upi/quote", upiQuote);
router.post("/upi/create", optionalCustomer, createUpi);
router.post("/upi/rupayex/callback", rupayexCallback);
router.get("/upi/rupayex/callback", rupayexCallback);
router.post("/crypto/ipn", ipn);
router.get("/:paymentId/status", status);
export default router;
