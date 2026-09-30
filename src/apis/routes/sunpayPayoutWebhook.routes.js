import { Router } from "express";
import { verifySunpayPayoutWebhook } from "../services/payoutProviders/sunpayPayout.service.js";
import {
  processSunpayPayoutWebhook,
  registerSunpayPayoutWebhook,
} from "../services/payoutProviders/sunpayPayoutWebhook.service.js";

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

    if (String(event?.event || "") !== "payout.updated") {
      return res.status(202).json({ success: true, ignored: true });
    }

    const registration = await registerSunpayPayoutWebhook(event, { rawBody });
    res.status(200).json({ success: true, duplicate: registration.duplicate });

    // Sunpay callbacks are notification-only. Persist receipt first, acknowledge
    // immediately, then reconcile against the authoritative payout status API.
    setImmediate(() => {
      processSunpayPayoutWebhook(registration.eventKey).catch(error => {
        console.error("Sunpay payout reconciliation failed after webhook:", {
          payoutId: event?.payout_id,
          eventKey: registration.eventKey,
          code: error?.code,
          message: error?.message,
        });
      });
    });
  } catch (error) {
    next(error);
  }
});

export default router;
