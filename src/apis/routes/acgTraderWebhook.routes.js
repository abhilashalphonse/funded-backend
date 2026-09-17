import { Router } from "express";
import controller from "../controllers/acgTraderWebhook.controller.js";

const router = Router();
router.post("/webhooks/acg-trader", controller.receive.bind(controller));

export default router;
