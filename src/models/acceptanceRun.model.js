import mongoose from "mongoose";

const AcceptanceRunSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ["CREATING", "READY", "RUNNING", "PASS", "FAIL", "CLEANED"],
      default: "CREATING",
      index: true,
    },
    createdBy: { type: String, required: true },
    reason: { type: String, default: null },
    symbol: { type: String, default: "BTCUSD" },
    volume: { type: String, default: "0.01" },
    fixture: { type: mongoose.Schema.Types.Mixed, default: {} },
    preflight: { type: mongoose.Schema.Types.Mixed, default: null },
    report: { type: mongoose.Schema.Types.Mixed, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    cleanedAt: { type: Date, default: null },
    error: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true, versionKey: false },
);

AcceptanceRunSchema.index({ createdAt: -1 });

export default mongoose.model("AcceptanceRun", AcceptanceRunSchema);
