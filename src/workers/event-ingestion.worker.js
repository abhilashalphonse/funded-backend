import Event from "../events/event.model.js";
import Stream from "../events/stream.model.js";
import { v5 as uuidv5 } from "uuid";

const STATE_JOB_NAMESPACE = uuidv5.URL;
const MAX_RETRIES = 5;

export function stateJobId(eventId) {
    return uuidv5(String(eventId), STATE_JOB_NAMESPACE);
}

export default class EventIngestionWorker {
    constructor(boss) {
        this.boss = boss;
    }

    async start() {
        await this.boss.work("incoming-events", { batchSize: 50, newJobCheckInterval: 100 }, async (jobOrJobs) => {
            const jobs = Array.isArray(jobOrJobs) ? jobOrJobs : [jobOrJobs];

            for (const job of jobs) {
                if (!job?.data) {
                    throw new Error("incoming-events worker received an invalid pg-boss job payload");
                }

                try {
                    await this.ingest(job.data);
                } catch (err) {
                    console.error("❌ INGEST FAILED:", err);
                    throw err;
                }
            }
        });

        console.log("EventIngestionWorker started");
    }

    async ingest(event) {
        this.validate(event);

        const existing = await Event.findOne({ eventId: event.eventId }).lean();
        if (existing) {
            await this.enqueueStateEvent(event.eventId);
            return;
        }

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                // Stream version allocation is an atomic single-document write.
                // Keeping it outside a multi-document transaction avoids the
                // write-conflict hotspot created by high-frequency valuations
                // for the same trading account.
                const stream = await Stream.findOneAndUpdate(
                    { accountId: event.aggregateId },
                    { $inc: { lastVersion: 1 } },
                    {
                        upsert: true,
                        new: true,
                        setDefaultsOnInsert: true,
                    }
                );

                const fullEvent = {
                    eventId: event.eventId,
                    aggregateId: event.aggregateId,
                    eventType: event.eventType,
                    streamVersion: stream.lastVersion,
                    occurredAt: event.timestamp ?? new Date(),
                    receivedAt: new Date(),
                    payload: event.payload,
                    metadata: event.metadata ?? {},
                };

                try {
                    await Event.create(fullEvent);
                } catch (error) {
                    if (isDuplicateEventId(error)) {
                        await this.enqueueStateEvent(event.eventId);
                        return;
                    }
                    throw error;
                }

                await this.enqueueStateEvent(event.eventId);
                return;
            } catch (err) {
                if (isRetryableMongoError(err) && attempt < MAX_RETRIES) {
                    await delay(attempt * 25);
                    continue;
                }
                throw err;
            }
        }
    }

    async enqueueStateEvent(eventId) {
        return this.boss.send(
            "state-events",
            { eventId },
            {
                id: stateJobId(eventId),
                retryLimit: 5,
                retryDelay: 1,
                retryBackoff: true,
            }
        );
    }

    validate(event) {
        if (!event?.eventId) throw new Error("eventId missing");
        if (!event?.eventType) throw new Error("eventType missing");
        if (!event?.aggregateId) throw new Error("aggregateId missing");
        if (!event?.payload) throw new Error("payload missing");
    }
}

function isRetryableMongoError(error) {
    return error?.code === 112
        || error?.codeName === "WriteConflict"
        || error?.errorLabels?.includes?.("TransientTransactionError")
        || String(error?.message || "").includes("WriteConflict")
        || String(error?.message || "").includes("Please retry");
}

function isDuplicateEventId(error) {
    if (error?.code !== 11000) return false;
    const pattern = error?.keyPattern || {};
    if (pattern.eventId) return true;
    return String(error?.message || "").includes("eventId_1");
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
