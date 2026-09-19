import express from "express";
import { requireCustomer } from "../../auth/supabaseAuth.js";
import {
  closeDemoPosition,
  ensureDemoAccount,
  getCustomerWorkspace,
  listCustomerAccounts,
  placeDemoOrder,
} from "../services/customer.service.js";
import { createCustomerTradingLaunch } from "../services/tradingLaunch.service.js";
import { getTradingReadiness } from "../services/tradingReadiness.service.js";
import { recordAnalyticsEvent } from "../services/analytics.service.js";
import { completeAcademyLesson, getAcademyProgress, viewAcademyLesson } from "../services/academy.service.js";
import { getCustomerNewsCalendar } from "../services/newsCalendar.service.js";

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

router.get("/academy/progress", async (req, res, next) => {
  try {
    const data = await getAcademyProgress(req.customer);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.post("/academy/lessons/:lessonId/view", async (req, res, next) => {
  try {
    const data = await viewAcademyLesson(req.customer, req.params.lessonId);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.post("/academy/lessons/:lessonId/complete", async (req, res, next) => {
  try {
    const data = await completeAcademyLesson(req.customer, req.params.lessonId, {
      score: req.body?.score ?? null,
    });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get("/news-calendar", async (req, res, next) => {
  try {
    const data = await getCustomerNewsCalendar(req.customer, {
      from: req.query.from,
      to: req.query.to,
      currencies: req.query.currencies,
      accountId: req.query.accountId,
    });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get("/trial-readiness", async (_req, res, next) => {
  try {
    const data = await getTradingReadiness();
    res.status(data.ready ? 200 : 503).json({ success: data.ready, data, message: data.error || undefined });
  } catch (error) { next(error); }
});

router.post("/accounts/:accountId/trading-launch", async (req, res, next) => {
  try {
    const data = await createCustomerTradingLaunch(req.customer, req.params.accountId);
    await recordAnalyticsEvent({
      event: "trader_opened",
      sessionId: req.get("x-acg-session-id") || `user:${req.customer.id}`,
      customer: req.customer,
      accountId: data.accountId,
      source: "server",
      properties: { platform: "acg-trader" },
    }).catch(() => {});
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.post("/demo-account", async (req, res, next) => {
  try {
    const data = await ensureDemoAccount(req.customer, req.body || {});
    await recordAnalyticsEvent({
      event: "trial_created",
      sessionId: req.get("x-acg-session-id") || `user:${req.customer.id}`,
      customer: req.customer,
      accountId: data.accountId,
      source: "server",
      properties: {
        accountSize: data.accountSize,
        challengeType: data.challengeType,
      },
    }).catch(() => {});
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
});

router.post("/demo-account/:accountId/orders", async (req, res, next) => {
  try {
    const data = await placeDemoOrder(req.customer, req.params.accountId, req.body || {});
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
});

router.post("/demo-account/:accountId/positions/:positionId/close", async (req, res, next) => {
  try {
    const data = await closeDemoPosition(req.customer, req.params.accountId, req.params.positionId, req.body || {});
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

export default router;
