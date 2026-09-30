import crypto from "node:crypto";
import ProviderWebhookEvent from "../../../models/providerWebhookEvent.model.js";
import {
  noteSunpayPayoutWebhook,
  reconcileSunpayPayout,
} from "./payoutExecution.service.js";

function clean(value) {
  return String(value || "").trim();
}

const WEBHOOK_PROCESSING_LEASE_MS = 2 * 60 * 1000;

function webhookError(error) {
  return {
    code: clean(error?.code || "SUNPAY_PAYOUT_WEBHOOK_PROCESSING_FAILED").slice(0, 120),
    message: clean(error?.message || "Sunpay payout webhook processing failed.").slice(0, 1000),
  };
}

export function sunpayPayoutWebhookIdentity(event = {}) {
  const eventType = clean(event.event);
  if (eventType !== "payout.updated") {
    const error = new Error("Unexpected Sunpay payout webhook event.");
    error.status = 400;
    error.code = "SUNPAY_PAYOUT_WEBHOOK_EVENT_INVALID";
    throw error;
  }

  const providerEventId = clean(event.id);
  if (!providerEventId) {
    const error = new Error("Sunpay payout webhook is missing its provider event id.");
    error.status = 400;
    error.code = "SUNPAY_PAYOUT_WEBHOOK_EVENT_ID_REQUIRED";
    throw error;
  }

  const payoutId = clean(event.payout_id);
  if (!payoutId) {
    const error = new Error("Sunpay payout webhook is missing payout_id.");
    error.status = 400;
    error.code = "SUNPAY_PAYOUT_WEBHOOK_PAYOUT_ID_REQUIRED";
    throw error;
  }

  return {
    eventKey: `sunpay:${eventType}:${providerEventId}`,
    provider: "sunpay",
    eventType,
    providerEventId,
    businessId: payoutId,
    providerReportedStatus: clean(event.status).toLowerCase() || null,
  };
}

export async function registerSunpayPayoutWebhook(
  event,
  {
    rawBody = null,
    eventModel = ProviderWebhookEvent,
    now = () => new Date(),
  } = {},
) {
  const identity = sunpayPayoutWebhookIdentity(event);
  const at = now();
  const payloadHash = rawBody
    ? crypto.createHash("sha256").update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody))).digest("hex")
    : null;

  try {
    const created = await eventModel.create({
      ...identity,
      payloadHash,
      status: "RECEIVED",
      deliveries: 1,
      attempts: 0,
      receivedAt: at,
      lastReceivedAt: at,
    });
    return {
      eventKey: identity.eventKey,
      duplicate: false,
      status: created?.status || "RECEIVED",
    };
  } catch (error) {
    if (error?.code !== 11000) throw error;

    const before = await eventModel.findOne({ eventKey: identity.eventKey });
    if (!before) throw error;

    const reportedStatusChanged = clean(before.providerReportedStatus).toLowerCase()
      !== clean(identity.providerReportedStatus).toLowerCase();
    const staleProcessing = String(before.status || "").toUpperCase() === "PROCESSING"
      && before.processingStartedAt
      && at.getTime() - new Date(before.processingStartedAt).getTime() >= WEBHOOK_PROCESSING_LEASE_MS;
    const shouldRequeue = reportedStatusChanged
      || String(before.status || "").toUpperCase() === "FAILED"
      || staleProcessing;

    const existing = await eventModel.findOneAndUpdate(
      { eventKey: identity.eventKey },
      {
        $set: {
          lastReceivedAt: at,
          providerReportedStatus: identity.providerReportedStatus,
          ...(payloadHash ? { payloadHash } : {}),
          ...(shouldRequeue ? {
            status: "RECEIVED",
            processingStartedAt: null,
            processedAt: null,
          } : {}),
        },
        $inc: { deliveries: 1 },
      },
      { new: true },
    );

    if (!existing) throw error;
    return {
      eventKey: identity.eventKey,
      duplicate: true,
      status: existing.status,
      requeued: shouldRequeue,
    };
  }
}

export async function processSunpayPayoutWebhook(
  eventKey,
  {
    eventModel = ProviderWebhookEvent,
    now = () => new Date(),
    noteWebhook = noteSunpayPayoutWebhook,
    reconcile = reconcileSunpayPayout,
  } = {},
) {
  const processingAt = now();
  const staleBefore = new Date(processingAt.getTime() - WEBHOOK_PROCESSING_LEASE_MS);
  const claimed = await eventModel.findOneAndUpdate(
    {
      eventKey: clean(eventKey),
      $or: [
        { status: { $in: ["RECEIVED", "FAILED"] } },
        { status: "PROCESSING", processingStartedAt: { $lte: staleBefore } },
      ],
    },
    {
      $set: {
        status: "PROCESSING",
        processingStartedAt: processingAt,
        lastError: { code: null, message: null },
      },
      $inc: { attempts: 1 },
    },
    { new: true },
  );

  if (!claimed) {
    return eventModel.findOne({ eventKey: clean(eventKey) });
  }

  try {
    await noteWebhook(claimed.businessId, { now });
    await reconcile(claimed.businessId);

    return eventModel.findOneAndUpdate(
      { eventKey: claimed.eventKey, status: "PROCESSING" },
      {
        $set: {
          status: "PROCESSED",
          processedAt: now(),
          lastError: { code: null, message: null },
        },
      },
      { new: true },
    );
  } catch (error) {
    await eventModel.findOneAndUpdate(
      { eventKey: claimed.eventKey, status: "PROCESSING" },
      {
        $set: {
          status: "FAILED",
          lastError: webhookError(error),
        },
      },
      { new: true },
    ).catch(() => null);
    throw error;
  }
}
