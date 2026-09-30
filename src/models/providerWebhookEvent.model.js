import mongoose from "mongoose";

export const PROVIDER_WEBHOOK_EVENT_STATUSES = Object.freeze([
  "RECEIVED",
  "PROCESSING",
  "PROCESSED",
  "FAILED",
]);

const ProviderWebhookEventSchema = new mongoose.Schema(
  {
    eventKey: { type: String, required: true, unique: true, index: true },
    provider: { type: String, required: true, index: true },
    eventType: { type: String, required: true, index: true },
    providerEventId: { type: String, required: true, index: true },
    businessId: { type: String, required: true, index: true },
    providerReportedStatus: { type: String, default: null },
    payloadHash: { type: String, default: null },
    status: {
      type: String,
      enum: PROVIDER_WEBHOOK_EVENT_STATUSES,
      default: "RECEIVED",
      required: true,
      index: true,
    },
    deliveries: { type: Number, default: 1, min: 1 },
    attempts: { type: Number, default: 0, min: 0 },
    receivedAt: { type: Date, default: Date.now },
    lastReceivedAt: { type: Date, default: Date.now },
    processingStartedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
    lastError: {
      code: { type: String, default: null },
      message: { type: String, default: null },
    },
  },
  { timestamps: true, versionKey: false },
);

ProviderWebhookEventSchema.index(
  { provider: 1, eventType: 1, providerEventId: 1 },
  {
    name: "unique_provider_webhook_event",
    unique: true,
  },
);
ProviderWebhookEventSchema.index({ businessId: 1, receivedAt: -1 });

export default mongoose.model("ProviderWebhookEvent", ProviderWebhookEventSchema);
