import mongoose from "mongoose";

export const PAYOUT_STATUSES = Object.freeze([
  "REQUESTED",
  "REVIEWING",
  "APPROVED",
  "PROCESSING",
  "SENT",
  "PAID",
  "FAILED",
  "REJECTED",
  "CANCELLED",
]);

export const ACTIVE_PAYOUT_STATUSES = Object.freeze([
  "REQUESTED",
  "REVIEWING",
  "APPROVED",
  "PROCESSING",
  "SENT",
]);

const PayoutRequestSchema = new mongoose.Schema(
  {
    payoutId: { type: String, required: true, unique: true, index: true },
    customerId: { type: String, required: true, index: true },
    ownerExternalRef: { type: String, default: null, index: true, sparse: true },
    accountId: { type: String, required: true, index: true },

    // Set to accountId while a payout is active and cleared on a terminal state.
    // The unique partial index below enforces one in-flight payout per account.
    activeKey: { type: String, default: null },
    idempotencyKey: { type: String, default: null, trim: true },

    status: {
      type: String,
      enum: PAYOUT_STATUSES,
      default: "REQUESTED",
      required: true,
      index: true,
    },

    cycle: {
      key: { type: String, default: null },
      frequency: { type: String, default: null },
      anchorAt: { type: Date, default: null },
      eligibleAt: { type: Date, default: null },
    },

    snapshot: {
      realizedProfitUsd: { type: Number, required: true },
      profitSplitPercent: { type: Number, required: true },
      entitlementUsd: { type: Number, required: true },
      previouslyPaidUsd: { type: Number, default: 0 },
      previouslyReservedUsd: { type: Number, default: 0 },
      availableBeforeRequestUsd: { type: Number, required: true },
    },

    requestedAmountUsd: { type: Number, required: true, min: 0.01 },
    feePolicy: {
      type: String,
      enum: ["ACG_COVERS"],
      default: "ACG_COVERS",
      required: true,
    },

    method: {
      type: String,
      enum: ["UPI", "BANK", "USDT"],
      default: null,
    },
    settlementCurrency: { type: String, default: null },
    settlementAmount: { type: Number, default: null },
    fxRate: { type: Number, default: null },
    quoteId: { type: String, default: null },
    quoteExpiresAt: { type: Date, default: null },

    // Customer responses use only this masked snapshot. The full destination
    // payload is encrypted with AES-256-GCM in the fields below.
    destination: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    destinationEncrypted: { type: String, default: null, select: false },
    destinationIv: { type: String, default: null, select: false },
    destinationAuthTag: { type: String, default: null, select: false },
    destinationKeyVersion: { type: String, default: "v1", select: false },

    quoteSource: { type: String, default: null },
    quoteDate: { type: String, default: null },
    quoteStatus: {
      type: String,
      enum: ["LOCKED", "PROVIDER_PENDING"],
      default: null,
    },

    provider: { type: String, default: null },
    providerReference: { type: String, default: null, index: true, sparse: true },
    providerStatus: { type: String, default: null },
    providerFee: { type: Number, default: null },
    providerNetAmount: { type: Number, default: null },
    providerStatusCheckedAt: { type: Date, default: null },
    providerLastAttemptAt: { type: Date, default: null },
    providerLastError: {
      code: { type: String, default: null },
      message: { type: String, default: null },
      status: { type: Number, default: null },
      minimum: { type: Number, default: null },
      maximum: { type: Number, default: null },
    },
    providerWebhookAt: { type: Date, default: null },
    utr: { type: String, default: null, index: true, sparse: true },
    txHash: { type: String, default: null, index: true, sparse: true },
    network: { type: String, default: null },

    failure: {
      code: { type: String, default: null },
      message: { type: String, default: null },
    },

    requestedAt: { type: Date, default: Date.now },
    reviewingAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    processingAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

PayoutRequestSchema.index({ accountId: 1, createdAt: -1 });
PayoutRequestSchema.index({ customerId: 1, createdAt: -1 });

PayoutRequestSchema.index(
  { activeKey: 1 },
  {
    name: "unique_active_payout_per_account",
    unique: true,
    partialFilterExpression: { activeKey: { $type: "string" } },
  },
);

PayoutRequestSchema.index(
  { customerId: 1, idempotencyKey: 1 },
  {
    name: "unique_customer_payout_idempotency",
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
  },
);

export default mongoose.model("PayoutRequest", PayoutRequestSchema);
