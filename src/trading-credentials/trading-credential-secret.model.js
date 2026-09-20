import mongoose from "mongoose";

const TradingCredentialSecretSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true, index: true },
    platformAccountId: { type: String, required: true, unique: true, index: true },
    provider: { type: String, required: true, default: "acg-trader" },
    login: { type: String, required: true },
    encryptedPassword: { type: String, required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
    keyVersion: { type: String, default: "v1" },
    deliveryEmail: { type: String, default: null },
    delivery: {
      status: { type: String, enum: ["NOT_QUEUED", "PENDING", "SENT", "FAILED"], default: "NOT_QUEUED" },
      attempts: { type: Number, default: 0 },
      lastAttemptAt: { type: Date, default: null },
      sentAt: { type: Date, default: null },
      error: { type: String, default: null },
    },
    rotatedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

TradingCredentialSecretSchema.index({ accountId: 1, createdAt: -1 });

export default mongoose.model("TradingCredentialSecret", TradingCredentialSecretSchema);
