import express from "express";
import { optionalCustomer } from "../../auth/supabaseAuth.js";
import {
  escalateSupportConversation,
  getSupportConversation,
  sendSupportMessage,
} from "../../support/support.service.js";

const router = express.Router();
const buckets = new Map();
const WINDOW_MS = 5 * 60 * 1000;
const LIMIT = 20;

function supportSession(req) {
  return String(req.get("x-acg-support-session") || req.body?.sessionId || req.query?.sessionId || "")
    .trim()
    .slice(0, 120);
}

function rateLimit(req, res, next) {
  const key = req.customer?.customerId || supportSession(req) || req.ip;
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }
  if (current.count >= LIMIT) {
    return res.status(429).json({ success: false, message: "Too many support messages. Please try again shortly." });
  }
  current.count += 1;
  next();
}

router.use(optionalCustomer);
router.use(rateLimit);

router.post("/message", async (req, res, next) => {
  try {
    const data = await sendSupportMessage({
      customer: req.customer,
      anonymousSessionId: supportSession(req),
      conversationId: req.body?.conversationId,
      message: req.body?.message,
      pageContext: req.body?.pageContext,
    });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get("/conversations/:conversationId", async (req, res, next) => {
  try {
    const data = await getSupportConversation({
      customer: req.customer,
      anonymousSessionId: supportSession(req),
      conversationId: req.params.conversationId,
    });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.post("/conversations/:conversationId/escalate", async (req, res, next) => {
  try {
    const data = await escalateSupportConversation({
      customer: req.customer,
      anonymousSessionId: supportSession(req),
      conversationId: req.params.conversationId,
      reason: req.body?.reason,
    });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

export default router;
