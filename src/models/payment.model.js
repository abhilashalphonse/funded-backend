import mongoose from "mongoose";

const PaymentSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    ownerExternalRef: { type: String, index: true, sparse: true },
    customerId: { type: String, index: true, sparse: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    challengeDefinition: { type: mongoose.Schema.Types.Mixed, required: true },
    commercialConfig: { type: mongoose.Schema.Types.Mixed, required: true },
    amount: { type: Number, required: true },
    currency: { type: String, required: true, default: "EUR" },
    paymentMethod: { type: String, enum: ["BTC", "USDT_TRX"], required: true },
    provider: { type: String, default: "nowpayments" },
    providerPaymentId: { type: String, index: true, sparse: true },
    providerInvoiceId: { type: String, index: true, sparse: true },
    providerStatus: String,
    status: {
      type: String,
      enum: ["CREATED", "WAITING", "CONFIRMING", "PAID", "FAILED", "EXPIRED", "UNDERPAID", "REFUNDED"],
      default: "CREATED",
      index: true,
    },
    paidAmount: Number,
    paidCurrency: String,
    checkoutUrl: String,
    accountId: { type: String, index: true, sparse: true },
    activatedAt: Date,
    activation: {
      status: {
        type: String,
        enum: ["NOT_STARTED", "PENDING", "ACTIVE", "FAILED"],
        default: "NOT_STARTED",
        index: true,
      },
      error: { type: String, default: null },
      attemptedAt: { type: Date, default: null },
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    paidAt: Date,
  },
  { timestamps: true, versionKey: false }
);

PaymentSchema.index({ provider: 1, providerPaymentId: 1 }, { unique: true, sparse: true });

export default mongoose.model("Payment", PaymentSchema);
