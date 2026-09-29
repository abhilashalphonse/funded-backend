import { Router } from "express";
import {
  noteSunpayPayoutWebhook,
  reconcileSunpayPayout,
} from "../services/payoutProviders/payoutExecution.service.js";
import { verifySunpayPayoutWebhook } from "../services/payoutProviders/sunpayPayout.service.js";

const router = Router();

router.post("/", async (req, res, next) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
    const signature = req.get("x-signature") || "";
    if (!verifySunpayPayoutWebhook(rawBody, signature)) {
      return res.status(401).json({ success: false, message: "Invalid payout webhook signature." });
    }

    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({ success: false, message: "Invalid payout webhook body." });
    }

    if (String(event?.event || "") !== "payout.updated" || !event?.payout_id) {
      return res.status(202).json({ success: true, ignored: true });
    }

    const payout = await noteSunpayPayoutWebhook(event.payout_id);
    res.status(200).json({ success: true });

    if (payout) {
      setImmediate(() => {
        reconcileSunpayPayout(event.payout_id).catch(error => {
          console.error("Sunpay payout reconciliation failed after webhook:", {
            payoutId: event.payout_id,
            code: error?.code,
            message: error?.message,
          });
        });
      });
    }
  } catch (error) {
    next(error);
  }
});

export default router;
