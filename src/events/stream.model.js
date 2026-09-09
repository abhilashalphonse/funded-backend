import mongoose from "mongoose";

const StreamSchema = new mongoose.Schema(
    {
        accountId: {
            type: String,
            required: true,
            unique: true
        },

        lastVersion: {
            type: Number,
            default: 0
        }
    },
    { versionKey: false }
);

export default mongoose.model("Stream", StreamSchema);