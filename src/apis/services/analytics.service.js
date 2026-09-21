import AnalyticsEvent from "../../models/analyticsEvent.model.js";

const ALLOWED_EVENTS = new Set([
  "landing_view",
  "hero_cta_click",
  "free_trial_click",
  "challenge_builder_view",
  "challenge_builder_viewed",
  "challenge_configured",
  "challenge_selected",
  "signup_started",
  "signup_completed",
  "trial_created",
  "trial_phase_1_passed",
  "trial_passed",
  "trial_completed",
  "trial_failed",
  "trader_opened",
  "trader_session_ready",
  "trader_launch_failed",
  "first_trade",
  "first_order_submitted",
  "first_order_filled",
  "phase_1_passed",
  "phase_2_started",
  "evaluation_passed",
  "checkout_started",
  "checkout_viewed",
  "checkout_submitted",
  "payment_started",
  "payment_completed",
  "payment_failed",
  "payment_cancelled",
  "payment_expired",
  "account_activated",
  "challenge_activated",
]);

function cleanString(value, max = 256) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : undefined;
}

export async function recordAnalyticsEvent({
  event,
  sessionId,
  customer,
  email,
  accountId,
  paymentId,
  source = "client",
  attribution = {},
  context = {},
  properties = {},
  occurredAt,
}) {
  if (!ALLOWED_EVENTS.has(event)) {
    const error = new Error("Unsupported analytics event.");
    error.status = 400;
    throw error;
  }

  const normalizedSessionId = cleanString(sessionId, 128);
  if (!normalizedSessionId) {
    const error = new Error("sessionId is required.");
    error.status = 400;
    throw error;
  }

  return AnalyticsEvent.create({
    event,
    sessionId: normalizedSessionId,
    ownerExternalRef: cleanString(customer?.customerId || customer?.id || properties?.ownerExternalRef, 128),
    email: cleanString(customer?.email || email, 320)?.toLowerCase(),
    accountId: cleanString(accountId, 128),
    paymentId: cleanString(paymentId, 128),
    source,
    attribution: {
      utmSource: cleanString(attribution.utmSource),
      utmMedium: cleanString(attribution.utmMedium),
      utmCampaign: cleanString(attribution.utmCampaign),
      utmContent: cleanString(attribution.utmContent),
      utmTerm: cleanString(attribution.utmTerm),
      referral: cleanString(attribution.referral),
      affiliate: cleanString(attribution.affiliate),
      landingVariant: cleanString(attribution.landingVariant),
    },
    context: {
      path: cleanString(context.path, 512),
      referrer: cleanString(context.referrer, 1024),
      device: cleanString(context.device, 32),
      country: cleanString(context.country, 64),
      entryIntent: cleanString(context.entryIntent, 32),
    },
    properties: properties && typeof properties === "object" ? properties : {},
    occurredAt: occurredAt ? new Date(occurredAt) : new Date(),
  });
}

export async function getFunnelSummary({ days = 30 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 30, 1), 365);
  const from = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);

  const rows = await AnalyticsEvent.aggregate([
    { $match: { occurredAt: { $gte: from } } },
    {
      $group: {
        _id: "$event",
        events: { $sum: 1 },
        sessions: { $addToSet: "$sessionId" },
        users: { $addToSet: "$ownerExternalRef" },
      },
    },
    {
      $project: {
        _id: 0,
        event: "$_id",
        events: 1,
        sessions: { $size: "$sessions" },
        users: {
          $size: {
            $filter: {
              input: "$users",
              as: "user",
              cond: { $and: [{ $ne: ["$$user", null] }, { $ne: ["$$user", ""] }] },
            },
          },
        },
      },
    },
  ]);

  const byEvent = Object.fromEntries(rows.map(row => [row.event, row]));
  return { from, to: new Date(), days: safeDays, byEvent };
}


export async function recordAnalyticsEventOnce(args, dedupe = {}) {
  const filter = {
    event: args.event,
    ...(dedupe.paymentId ? { paymentId: String(dedupe.paymentId) } : {}),
    ...(dedupe.accountId ? { accountId: String(dedupe.accountId) } : {}),
    ...(dedupe.sessionId ? { sessionId: String(dedupe.sessionId) } : {}),
  };
  const existing = await AnalyticsEvent.findOne(filter).select("_id").lean();
  if (existing) return existing;
  return recordAnalyticsEvent(args);
}
