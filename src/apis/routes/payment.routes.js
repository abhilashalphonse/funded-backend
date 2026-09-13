import { Router } from "express";
import { createCrypto, ipn, status } from "../controllers/payment.controller.js";

const router = Router();
router.post("/crypto/create", createCrypto);
router.post("/crypto/ipn", ipn);
router.get("/:paymentId/status", status);
export default router;
