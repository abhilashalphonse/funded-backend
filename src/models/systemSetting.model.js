import mongoose from "mongoose";

const SystemSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true, trim: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    updatedBy: { type: String, default: null, lowercase: true, trim: true },
  },
  { timestamps: true, versionKey: false },
);

export default mongoose.model("SystemSetting", SystemSettingSchema);
