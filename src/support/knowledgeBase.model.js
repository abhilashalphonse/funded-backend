import mongoose from "mongoose";

const KnowledgeBaseArticleSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    category: {
      type: String,
      enum: ["CHALLENGE", "RISK", "PHASE", "FREE_TRIAL", "ACG_TRADER", "PAYMENT", "PAYOUT", "REFUND", "PROHIBITED_STRATEGIES", "ACCOUNT"],
      required: true,
      index: true,
    },
    summary: { type: String, required: true },
    content: { type: String, required: true },
    keywords: { type: [String], default: [] },
    approved: { type: Boolean, default: false, index: true },
    source: { type: String, enum: ["SYSTEM", "ADMIN"], default: "SYSTEM" },
    version: { type: Number, default: 1 },
    approvedAt: { type: Date, default: null },
    lastReviewedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

KnowledgeBaseArticleSchema.index({ approved: 1, category: 1 });
KnowledgeBaseArticleSchema.index({ title: "text", summary: "text", content: "text", keywords: "text" });

export default mongoose.model("KnowledgeBaseArticle", KnowledgeBaseArticleSchema);
