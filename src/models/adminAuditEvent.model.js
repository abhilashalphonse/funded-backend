import mongoose from "mongoose";

const AdminAuditEventSchema = new mongoose.Schema(
  {
    adminEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
    action: { type: String, required: true, trim: true, index: true },
    entityType: { type: String, required: true, trim: true, index: true },
    entityId: { type: String, required: true, trim: true, index: true },
    reason: { type: String, default: "", trim: true },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    requestId: { type: String, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

AdminAuditEventSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
AdminAuditEventSchema.index({ createdAt: -1 });

export default mongoose.model("AdminAuditEvent", AdminAuditEventSchema);
