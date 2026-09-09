 // routes/tradeWebhook.routes.js

import express from "express";
import TradeWebhookController from "../controllers/tradeWebhook.controller.js";

const router = express.Router();

router.post("/trade-webhook", TradeWebhookController.receive);

export default router; 