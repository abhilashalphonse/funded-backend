import mongoose from "mongoose";

const CustomerSchema = new mongoose.Schema(
  {
    customerId: { type: String, required: true, unique: true, immutable: true, index: true },
    supabaseUserId: { type: String, default: undefined, index: true },
    primaryEmail: { type: String, required: true, lowercase: true, trim: true, unique: true, index: true },
    emailAliases: { type: [String], default: [] },
    status: { type: String, enum: ["ACTIVE", "BLOCKED", "MERGED"], default: "ACTIVE", index: true },
    mergedIntoCustomerId: { type: String, default: undefined, index: true },
    authLinkedAt: { type: Date, default: null },
    lastAuthenticatedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

CustomerSchema.index(
  { supabaseUserId: 1 },
  {
    unique: true,
    partialFilterExpression: { supabaseUserId: { $type: "string" } },
  },
);

export default mongoose.model("Customer", CustomerSchema);
