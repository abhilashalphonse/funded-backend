import mongoose from "mongoose";

const EventSchema = new mongoose.Schema(
    {
        eventId: {
            type: String,
            required: true,
            unique: true,
            index: true
        },

        aggregateId: {
            type: String,
            required: true,
            index: true
        },

        streamVersion: {
            type: Number,
            required: true
        },

        eventType: {
            type: String,
            required: true,
            index: true
        },

        occurredAt: {
            type: Date,
            default: Date.now
        },

        receivedAt: {
            type: Date,
            default: Date.now
        },

        payload: {
            type: mongoose.Schema.Types.Mixed,
            default: {}
        },

        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: {}
        }
    },
    {
        versionKey: false
    }
);

// One event version per aggregate
EventSchema.index(
    { aggregateId: 1, streamVersion: 1 },
    { unique: true }
);

export default mongoose.model("Event", EventSchema);