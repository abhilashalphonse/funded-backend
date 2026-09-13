import mongoose from "mongoose";

const PaymentSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
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
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    paidAt: Date,
  },
  { timestamps: true, versionKey: false }
);

PaymentSchema.index({ provider: 1, providerPaymentId: 1 }, { unique: true, sparse: true });

export default mongoose.model("Payment", PaymentSchema);
