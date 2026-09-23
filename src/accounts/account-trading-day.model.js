import mongoose from "mongoose";

const AccountTradingDaySchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true, index: true },
    phase: { type: Number, required: true },
    platformAccountId: { type: String, required: true },
    dayKey: { type: String, required: true },
    firstDealEventId: { type: String, default: null },
    firstExecutedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

AccountTradingDaySchema.index(
  { accountId: 1, phase: 1, platformAccountId: 1, dayKey: 1 },
  { unique: true },
);

export default mongoose.model("AccountTradingDay", AccountTradingDaySchema);
