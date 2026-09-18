import mongoose from "mongoose";

const AnalyticsEventSchema = new mongoose.Schema(
  {
    event: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    ownerExternalRef: { type: String, index: true, sparse: true },
    email: { type: String, lowercase: true, trim: true, index: true, sparse: true },
    accountId: { type: String, index: true, sparse: true },
    paymentId: { type: String, index: true, sparse: true },
    source: { type: String, enum: ["client", "server"], default: "client", index: true },
    attribution: {
      utmSource: String,
      utmMedium: String,
      utmCampaign: String,
      utmContent: String,
      utmTerm: String,
      referral: String,
      affiliate: String,
      landingVariant: String,
    },
    context: {
      path: String,
      referrer: String,
      device: String,
      country: String,
      entryIntent: String,
    },
    properties: { type: mongoose.Schema.Types.Mixed, default: {} },
    occurredAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true, versionKey: false },
);

AnalyticsEventSchema.index({ event: 1, occurredAt: -1 });
AnalyticsEventSchema.index({ ownerExternalRef: 1, occurredAt: -1 });
AnalyticsEventSchema.index({ sessionId: 1, occurredAt: -1 });

export default mongoose.model("AnalyticsEvent", AnalyticsEventSchema);
