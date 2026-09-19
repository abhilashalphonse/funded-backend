import mongoose from "mongoose";

const MessageSchema = new mongoose.Schema({
  messageId: { type: String, required: true },
  role: { type: String, enum: ["user", "assistant", "system"], required: true },
  content: { type: String, required: true },
  source: { type: String, enum: ["customer", "ai", "fallback", "human"], required: true },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const SupportConversationSchema = new mongoose.Schema({
  conversationId: { type: String, required: true, unique: true, index: true },
  customerId: { type: String, index: true, sparse: true },
  anonymousSessionId: { type: String, index: true, sparse: true },
  status: { type: String, enum: ["OPEN", "ESCALATED", "CLOSED"], default: "OPEN", index: true },
  category: { type: String, default: "GENERAL", index: true },
  handoffReason: { type: String, default: null },
  pageContext: { type: String, default: null },
  messages: { type: [MessageSchema], default: [] },
  lastMessageAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true, versionKey: false });

SupportConversationSchema.index({ customerId: 1, lastMessageAt: -1 });
SupportConversationSchema.index({ anonymousSessionId: 1, lastMessageAt: -1 });

export default mongoose.model("SupportConversation", SupportConversationSchema);
