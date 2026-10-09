import AnalyticsEvent from "../../models/analyticsEvent.model.js";
import Customer from "../../customers/customer.model.js";
import Payment from "../../models/payment.model.js";
import { getCustomerCohortJourneys } from "./customerJourneyMetrics.js";

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
  "trial_first_trade",
  "trial_phase_1_passed",
  "trial_passed",
  "trial_completed",
  "trial_failed",
  "trial_expired",
  "trial_cancelled",
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
  "post_purchase_signup_started",
  "post_purchase_signup_completed",
  "dashboard_opened_after_purchase",
]);

// Browser telemetry is observational; lifecycle changes come from Funded services.
const CLIENT_EVENTS = new Set([
  "landing_view", "hero_cta_click", "free_trial_click",
  "challenge_builder_view", "challenge_builder_viewed",
  "challenge_configured", "challenge_selected",
  "signup_started", "signup_completed",
  "checkout_started", "checkout_viewed", "checkout_submitted",
  "payment_cancelled", "payment_failed", "trader_launch_failed",
  "post_purchase_signup_started", "post_purchase_signup_completed",
  "dashboard_opened_after_purchase",
]);

function cleanClientProperties(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, field] of Object.entries(value).slice(0, 24)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,64}$/.test(key)
      || /customer|owner|email|accountid|paymentid|token|secret|password|session|attribution/i.test(key)) continue;
    if (typeof field === "string") result[key] = field.slice(0, 256);
    else if (typeof field === "number" && Number.isFinite(field)) result[key] = field;
    else if (typeof field === "boolean") result[key] = field;
  }
  return result;
}

const TOUCH_FIELDS = [
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmContent",
  "utmTerm",
  "referral",
  "affiliate",
  "landingVariant",
  "creatorId",
  "creativeId",
  "market",
  "language",
  "hook",
];

function cleanString(value, max = 256) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : undefined;
}

function cleanDate(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function cleanTouch(value = {}) {
  const touch = {};
  for (const field of TOUCH_FIELDS) {
    const cleaned = cleanString(value?.[field]);
    if (cleaned) touch[field] = cleaned;
  }
  const capturedAt = cleanDate(value?.capturedAt);
  if (capturedAt) touch.capturedAt = capturedAt;
  return touch;
}

function legacyTouch(attribution = {}) {
  return cleanTouch(attribution);
}

function hasTouch(touch = {}) {
  return TOUCH_FIELDS.some(field => Boolean(touch?.[field]));
}

function normalizeAttribution(attribution = {}) {
  const legacy = legacyTouch(attribution);
  let firstTouch = cleanTouch(attribution?.firstTouch);
  let lastTouch = cleanTouch(attribution?.lastTouch);

  if (!hasTouch(firstTouch) && hasTouch(legacy)) firstTouch = legacy;
  if (!hasTouch(lastTouch) && hasTouch(legacy)) lastTouch = legacy;
  if (!hasTouch(lastTouch) && hasTouch(firstTouch)) lastTouch = firstTouch;

  const primary = hasTouch(firstTouch) ? firstTouch : lastTouch;
  const normalized = {
    anonymousId: cleanString(attribution?.anonymousId, 128),
  };

  if (hasTouch(primary)) {
    for (const field of TOUCH_FIELDS) {
      if (primary[field]) normalized[field] = primary[field];
    }
  }
  if (hasTouch(firstTouch)) normalized.firstTouch = firstTouch;
  if (hasTouch(lastTouch)) normalized.lastTouch = lastTouch;
  return normalized;
}

function mergeAttribution(stored = {}, incoming = {}) {
  const saved = normalizeAttribution(stored);
  const next = normalizeAttribution(incoming);
  const firstTouch = hasTouch(saved.firstTouch) ? saved.firstTouch : next.firstTouch;
  const lastTouch = hasTouch(next.lastTouch) ? next.lastTouch : (saved.lastTouch || firstTouch);
  return normalizeAttribution({
    anonymousId: saved.anonymousId || next.anonymousId,
    firstTouch,
    lastTouch,
  });
}

async function resolveCustomerAttribution({ customerId, email, incoming, allowWrite = false }) {
  const normalizedEmail = cleanString(email, 320)?.toLowerCase();
  let record = null;
  if (customerId) {
    record = await Customer.findOne({ customerId }).select("customerId marketingAttribution").lean();
  } else if (normalizedEmail) {
    record = await Customer.findOne({ primaryEmail: normalizedEmail }).select("customerId marketingAttribution").lean();
  }

  if (!record) return normalizeAttribution(incoming);

  const merged = mergeAttribution(record.marketingAttribution || {}, incoming);
  const hasIncoming = hasTouch(normalizeAttribution(incoming).firstTouch)
    || hasTouch(normalizeAttribution(incoming).lastTouch);

  if (hasIncoming && allowWrite && customerId) {
    await Customer.updateOne(
      { customerId: record.customerId },
      { $set: { marketingAttribution: merged } },
    );
  }
  return merged;
}

function eventCount(byEvent, event) {
  return Number(byEvent?.[event]?.events || 0);
}

function ratio(numerator, denominator) {
  const a = Number(numerator || 0);
  const b = Number(denominator || 0);
  return b > 0 ? a / b : 0;
}

export async function recordAnalyticsEvent({
  event,
  eventKey,
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
  if (!ALLOWED_EVENTS.has(event) || (source === "client" && !CLIENT_EVENTS.has(event))) {
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

  const fromClient = source === "client";
  const safeProperties = fromClient ? cleanClientProperties(properties) : properties;
  const customerId = cleanString(customer?.customerId || (!fromClient && properties?.customerId), 128);
  const normalizedEmail = cleanString(customer?.email || (!fromClient && email), 320)?.toLowerCase();
  let normalizedAttribution = normalizeAttribution(attribution);

  if (customerId || (!fromClient && normalizedEmail)) {
    try {
      normalizedAttribution = await resolveCustomerAttribution({
        customerId,
        email: normalizedEmail,
        incoming: normalizedAttribution,
        allowWrite: Boolean(customer?.customerId),
      });
    } catch (error) {
      console.warn("[analytics] customer attribution persistence failed", {
        customerId,
        event,
        message: error?.message,
      });
    }
  }

  return AnalyticsEvent.create({
    event,
    eventKey: fromClient ? undefined : cleanString(eventKey, 384),
    sessionId: normalizedSessionId,
    ownerExternalRef: customerId || (!fromClient && cleanString(customer?.id || properties?.ownerExternalRef, 128)),
    email: normalizedEmail,
    accountId: fromClient ? undefined : cleanString(accountId, 128),
    paymentId: fromClient ? undefined : cleanString(paymentId, 128),
    source,
    attribution: normalizedAttribution,
    context: {
      path: cleanString(context.path, 512),
      referrer: cleanString(context.referrer, 1024),
      device: cleanString(context.device, 32),
      country: cleanString(context.country, 64),
      entryIntent: cleanString(context.entryIntent, 32),
    },
    properties: safeProperties && typeof safeProperties === "object" ? safeProperties : {},
    occurredAt: fromClient ? new Date() : (occurredAt ? new Date(occurredAt) : new Date()),
  });
}


async function getPaymentRevenueSummary(from) {
  const [paid, refunds, failures] = await Promise.all([
    Payment.aggregate([
      { $match: { status: "PAID", paidAt: { $gte: from } } },
      { $facet: {
        total: [{ $group: { _id: null, payments: { $sum: 1 }, salesUsd: { $sum: "$amount" } } }],
        methods: [
          { $group: { _id: "$paymentMethod", payments: { $sum: 1 }, salesUsd: { $sum: "$amount" } } },
          { $sort: { salesUsd: -1 } },
        ],
        products: [
          { $group: { _id: { size: "$challengeDefinition.accountSize", step: "$challengeDefinition.step" }, payments: { $sum: 1 }, salesUsd: { $sum: "$amount" } } },
          { $sort: { salesUsd: -1 } },
        ],
        sources: [
          { $project: {
            amount: 1,
            source: { $ifNull: ["$metadata.attribution.firstTouch.utmSource", "$metadata.attribution.utmSource"] },
            medium: { $ifNull: ["$metadata.attribution.firstTouch.utmMedium", "$metadata.attribution.utmMedium"] },
            campaign: { $ifNull: ["$metadata.attribution.firstTouch.utmCampaign", "$metadata.attribution.utmCampaign"] },
            creatorId: { $ifNull: ["$metadata.attribution.firstTouch.creatorId", "$metadata.attribution.creatorId"] },
            creativeId: { $ifNull: ["$metadata.attribution.firstTouch.creativeId", "$metadata.attribution.creativeId"] },
            market: { $ifNull: ["$metadata.attribution.firstTouch.market", "$metadata.attribution.market"] },
            language: { $ifNull: ["$metadata.attribution.firstTouch.language", "$metadata.attribution.language"] },
            hook: { $ifNull: ["$metadata.attribution.firstTouch.hook", "$metadata.attribution.hook"] },
          } },
          { $group: { _id: { source: "$source", medium: "$medium", campaign: "$campaign", creatorId: "$creatorId", creativeId: "$creativeId", market: "$market", language: "$language", hook: "$hook" }, payments: { $sum: 1 }, salesUsd: { $sum: "$amount" } } },
        ],
      } },
    ]),
    Payment.aggregate([
      { $match: { status: "REFUNDED", updatedAt: { $gte: from } } },
      { $group: { _id: null, payments: { $sum: 1 }, amountUsd: { $sum: "$amount" } } },
    ]),
    Payment.aggregate([
      { $match: { status: { $in: ["FAILED", "EXPIRED", "UNDERPAID"] }, updatedAt: { $gte: from } } },
      { $group: { _id: { provider: "$provider", status: "$status" }, payments: { $sum: 1 } } },
      { $sort: { payments: -1 } },
    ]),
  ]);
  const groups = paid[0] || {};
  const total = groups.total?.[0] || {};
  const sources = (groups.sources || []).map(row => ({
    source: row._id?.source || "unattributed",
    medium: row._id?.medium || "",
    campaign: row._id?.campaign || "",
    creatorId: row._id?.creatorId || "",
    creativeId: row._id?.creativeId || "",
    market: row._id?.market || "",
    language: row._id?.language || "",
    hook: row._id?.hook || "",
    paidConversions: Number(row.payments || 0),
    revenue: Number(row.salesUsd || 0),
  }));
  const attributed = sources.filter(row => row.source !== "unattributed" || row.campaign || row.creatorId || row.creativeId);
  return {
    paidPayments: Number(total.payments || 0),
    confirmedSalesUsd: Number(total.salesUsd || 0),
    attributedSalesUsd: attributed.reduce((sum, row) => sum + row.revenue, 0),
    unattributedSalesUsd: sources.filter(row => !attributed.includes(row)).reduce((sum, row) => sum + row.revenue, 0),
    refundedPayments: Number(refunds[0]?.payments || 0),
    refundedAmountUsd: Number(refunds[0]?.amountUsd || 0),
    failedPaymentOutcomes: failures.map(row => ({ provider: row._id?.provider || "Unknown", status: row._id?.status || "Unknown", payments: row.payments })),
    byMethod: (groups.methods || []).map(row => ({ method: row._id || "Unknown", paidPayments: row.payments, salesUsd: row.salesUsd })),
    byProduct: (groups.products || []).map(row => ({ accountSize: row._id?.size, step: row._id?.step, paidPayments: row.payments, salesUsd: row.salesUsd })),
    sources,
  };
}

export async function getFunnelSummary({ days = 30 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 30, 1), 365);
  const from = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);

  const [rows, attributedRows, journeys, revenueSummary] = await Promise.all([
    AnalyticsEvent.aggregate([
      { $match: { occurredAt: { $gte: from } } },
      {
        $group: {
          _id: "$event",
          events: { $sum: 1 },
          sessions: { $addToSet: "$sessionId" },
          users: { $addToSet: "$ownerExternalRef" },
          revenue: {
            $sum: {
              $cond: [
                { $eq: ["$event", "payment_completed"] },
                { $convert: { input: "$properties.amount", to: "double", onError: 0, onNull: 0 } },
                0,
              ],
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          event: "$_id",
          events: 1,
          revenue: 1,
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
    ]),
    AnalyticsEvent.aggregate([
      { $match: { occurredAt: { $gte: from } } },
      {
        $project: {
          event: 1,
          sessionId: 1,
          utmSource: { $ifNull: ["$attribution.firstTouch.utmSource", "$attribution.utmSource"] },
          utmMedium: { $ifNull: ["$attribution.firstTouch.utmMedium", "$attribution.utmMedium"] },
          utmCampaign: { $ifNull: ["$attribution.firstTouch.utmCampaign", "$attribution.utmCampaign"] },
          creatorId: { $ifNull: ["$attribution.firstTouch.creatorId", "$attribution.creatorId"] },
          creativeId: { $ifNull: ["$attribution.firstTouch.creativeId", "$attribution.creativeId"] },
          market: { $ifNull: ["$attribution.firstTouch.market", "$attribution.market"] },
          language: { $ifNull: ["$attribution.firstTouch.language", "$attribution.language"] },
          hook: { $ifNull: ["$attribution.firstTouch.hook", "$attribution.hook"] },
          amount: { $convert: { input: "$properties.amount", to: "double", onError: 0, onNull: 0 } },
        },
      },
      {
        $group: {
          _id: {
            event: "$event",
            utmSource: "$utmSource",
            utmMedium: "$utmMedium",
            utmCampaign: "$utmCampaign",
            creatorId: "$creatorId",
            creativeId: "$creativeId",
            market: "$market",
            language: "$language",
            hook: "$hook",
          },
          events: { $sum: 1 },
          sessions: { $addToSet: "$sessionId" },
          revenue: {
            $sum: {
              $cond: [{ $eq: ["$event", "payment_completed"] }, "$amount", 0],
            },
          },
        },
      },
      {
        $project: {
          _id: 1,
          events: 1,
          revenue: 1,
          sessions: { $size: "$sessions" },
        },
      },
    ]),
    getCustomerCohortJourneys(from),
    getPaymentRevenueSummary(from),
  ]);

  const byEvent = Object.fromEntries(rows.map(row => [row.event, row]));
  const acquisitionMap = new Map();

  for (const row of attributedRows) {
    const dimensions = {
      source: row._id?.utmSource || "unattributed",
      medium: row._id?.utmMedium || "",
      campaign: row._id?.utmCampaign || "",
      creatorId: row._id?.creatorId || "",
      creativeId: row._id?.creativeId || "",
      market: row._id?.market || "",
      language: row._id?.language || "",
      hook: row._id?.hook || "",
    };
    const key = JSON.stringify(dimensions);
    if (!acquisitionMap.has(key)) {
      acquisitionMap.set(key, {
        ...dimensions,
        visitors: 0,
        registrations: 0,
        trialsCreated: 0,
        activatedTrials: 0,
        trialPassed: 0,
        trialFailed: 0,
        checkoutStarts: 0,
        paidConversions: 0,
        revenue: 0,
      });
    }
    const item = acquisitionMap.get(key);
    const count = Number(row.events || 0);
    if (row._id?.event === "landing_view") item.visitors += Number(row.sessions || count);
    if (row._id?.event === "signup_completed") item.registrations += count;
    if (row._id?.event === "trial_created") item.trialsCreated += count;
    if (row._id?.event === "trial_first_trade") item.activatedTrials += count;
    if (row._id?.event === "trial_passed") item.trialPassed += count;
    if (row._id?.event === "trial_failed") item.trialFailed += count;
    if (row._id?.event === "checkout_started") item.checkoutStarts += count;
    // Paid conversions/revenue are sourced from Payment below, not event ingestion.
  }

  for (const source of revenueSummary.sources) {
    const { paidConversions, revenue, ...dimensions } = source;
    const key = JSON.stringify(dimensions);
    if (!acquisitionMap.has(key)) {
      acquisitionMap.set(key, { ...dimensions, visitors: 0, registrations: 0, trialsCreated: 0, activatedTrials: 0, trialPassed: 0, trialFailed: 0, checkoutStarts: 0, paidConversions: 0, revenue: 0 });
    }
    acquisitionMap.get(key).paidConversions += paidConversions;
    acquisitionMap.get(key).revenue += revenue;
  }

  const acquisition = [...acquisitionMap.values()]
    .filter(item => item.visitors || item.registrations || item.trialsCreated || item.activatedTrials || item.checkoutStarts || item.paidConversions)
    .map(item => ({
      ...item,
      registrationRate: ratio(item.registrations, item.visitors),
      trialRate: ratio(item.trialsCreated, item.registrations),
      activationRate: ratio(item.activatedTrials, item.trialsCreated),
      paidRate: null, // Paid orders can bypass trials; this is not a valid cohort denominator.
    }))
    .sort((a, b) => (b.paidConversions - a.paidConversions)
      || (b.activatedTrials - a.activatedTrials)
      || (b.registrations - a.registrations));

  const visitors = Number(byEvent.landing_view?.sessions || byEvent.landing_view?.events || 0);
  const registrations = eventCount(byEvent, "signup_completed");
  const trialsCreated = eventCount(byEvent, "trial_created");
  const activatedTrials = eventCount(byEvent, "trial_first_trade");
  const trialPassed = eventCount(byEvent, "trial_passed");
  const trialFailed = eventCount(byEvent, "trial_failed");
  const checkoutStarts = eventCount(byEvent, "checkout_started");
  const paidConversions = revenueSummary.paidPayments;
  const revenue = revenueSummary.confirmedSalesUsd;

  const kpis = {
    visitors,
    registrations,
    trialsCreated,
    activatedTrials,
    trialOutcomes: trialPassed + trialFailed,
    trialPassed,
    trialFailed,
    checkoutStarts,
    paidConversions,
    revenue,
    visitorToRegistration: ratio(registrations, visitors),
    registrationToTrial: ratio(trialsCreated, registrations),
    trialToActivation: ratio(activatedTrials, trialsCreated),
    activatedToCheckout: ratio(checkoutStarts, activatedTrials),
    checkoutToPaid: null, // Use the ordered paid journey for a meaningful conversion rate.
  };

  return { from, to: new Date(), days: safeDays, byEvent, kpis, acquisition, journeys, revenueSummary };
}

export async function recordAnalyticsEventOnce(args, dedupe = {}) {
  const legacyFilter = {
    event: args.event,
    ...(dedupe.paymentId ? { paymentId: String(dedupe.paymentId) } : {}),
    ...(dedupe.accountId ? { accountId: String(dedupe.accountId) } : {}),
    ...(dedupe.sessionId ? { sessionId: String(dedupe.sessionId) } : {}),
  };
  const hasDedupeScope = Boolean(dedupe.paymentId || dedupe.accountId || dedupe.sessionId);
  if (!hasDedupeScope) return recordAnalyticsEvent(args);

  // Preserve compatibility with rows created before eventKey existed.
  const existing = await AnalyticsEvent.findOne(legacyFilter).select("_id eventKey").lean();
  if (existing) return existing;

  const scope = dedupe.paymentId
    ? `payment:${String(dedupe.paymentId)}`
    : dedupe.accountId
      ? `account:${String(dedupe.accountId)}`
      : `session:${String(dedupe.sessionId)}`;

  const eventKey = `${String(args.event)}:${scope}`;
  try {
    return await recordAnalyticsEvent({ ...args, eventKey });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return AnalyticsEvent.findOne({ eventKey }).lean();
  }
}
