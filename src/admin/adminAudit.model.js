import mongoose from "mongoose";

const AdminAuditSchema = new mongoose.Schema(
  {
    adminUserId: { type: String, required: true, index: true },
    adminEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
    action: { type: String, required: true, index: true },
    entityType: { type: String, required: true, index: true },
    entityId: { type: String, required: true, index: true },
    reason: { type: String, default: null },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    requestId: { type: String, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

AdminAuditSchema.index({ createdAt: -1 });
AdminAuditSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

export default mongoose.model("AdminAudit", AdminAuditSchema);
