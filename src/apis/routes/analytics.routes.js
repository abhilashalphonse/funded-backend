import { Router } from "express";
import { optionalCustomer } from "../../auth/supabaseAuth.js";
import { getFunnelSummary, recordAnalyticsEvent } from "../services/analytics.service.js";

const router = Router();

router.post("/events", optionalCustomer, async (req, res, next) => {
  try {
    const body = req.body || {};
    const event = await recordAnalyticsEvent({
      ...body,
      customer: req.customer,
      source: "client",
    });
    res.status(201).json({ success: true, data: { id: event._id } });
  } catch (error) { next(error); }
});

router.get("/funnel", async (req, res, next) => {
  try {
    if (process.env.ENABLE_LOCAL_ADMIN_ROUTES !== "true" && process.env.NODE_ENV === "production") {
      return res.status(404).json({ success: false, message: "Not found." });
    }
    const data = await getFunnelSummary({ days: req.query.days });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

export default router;
