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
    currency: { type: String, enum: ["USD"], required: true, default: "USD" },
    paymentMethod: { type: String, enum: ["UPI", "BTC", "USDT_TRX"], required: true },
    providerAmount: Number,
    providerCurrency: String,
    utr: { type: String, index: true, sparse: true },
    statusTokenHash: { type: String, index: true, sparse: true },
    providerLastCheckedAt: Date,
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

PaymentSchema.index(
  { provider: 1, providerPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      providerPaymentId: { $type: "string" },
    },
  },
);

const Payment = mongoose.model("Payment", PaymentSchema);

export async function normalizePaymentCurrencyLabels() {
  await Payment.updateMany(
    { currency: { $in: ["EUR", "eur", null, ""] } },
    { $set: { currency: "USD" } },
  );
}

export async function ensurePaymentProviderIndex() {
  const indexName = "provider_1_providerPaymentId_1";
  const indexes = await Payment.collection.indexes();
  const existing = indexes.find((index) => index.name === indexName);

  const hasExpectedPartialFilter =
    existing?.unique === true &&
    existing?.partialFilterExpression?.providerPaymentId?.$type === "string";

  if (existing && !hasExpectedPartialFilter) {
    await Payment.collection.dropIndex(indexName);
  }

  if (!existing || !hasExpectedPartialFilter) {
    await Payment.collection.createIndex(
      { provider: 1, providerPaymentId: 1 },
      {
        name: indexName,
        unique: true,
        partialFilterExpression: {
          providerPaymentId: { $type: "string" },
        },
      },
    );
  }

  const utrIndexName = "provider_1_utr_1";
  const utrIndexes = await Payment.collection.indexes();
  const existingUtr = utrIndexes.find((index) => index.name === utrIndexName);
  const hasExpectedUtrFilter =
    existingUtr?.unique === true &&
    existingUtr?.partialFilterExpression?.utr?.$type === "string";

  if (existingUtr && !hasExpectedUtrFilter) {
    await Payment.collection.dropIndex(utrIndexName);
  }

  if (!existingUtr || !hasExpectedUtrFilter) {
    await Payment.collection.createIndex(
      { provider: 1, utr: 1 },
      {
        name: utrIndexName,
        unique: true,
        partialFilterExpression: {
          utr: { $type: "string" },
        },
      },
    );
  }
}

export default Payment;
