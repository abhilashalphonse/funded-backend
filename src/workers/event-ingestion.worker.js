import Event from "../events/event.model.js";
import Stream from "../events/stream.model.js";

export default class EventIngestionWorker {   
    constructor(boss) {
        this.boss = boss;
    }

   async start() {
   await this.boss.work(
    "incoming-events",
    async (jobs) => {
        const job = jobs[0];

        try {
            console.log("🔥 INCOMING EVENT RECEIVED");
            await this.ingest(job.data);
        } catch (err) {
            console.error("❌ INGEST FAILED:", err);
            throw err; // Let PgBoss handle retries
        }
    }
);

    console.log("EventIngestionWorker started");      
}

   
   
    async ingest(event) {
        console.log("✅ Validation passed");
        this.validate(event);
        
        
       

        const MAX_RETRIES = 3;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) { 
            // Use Event's db connection since Account is no longer imported here
            console.log("✅ Starting Mongo session");
            const session = await Event.db.startSession();
            console.log("✅ Session started");

            try {
                session.startTransaction();

                // 1. Idempotency Guard
                const exists = await Event.findOne({
                    eventId: event.eventId
                }).session(session);

                console.log("Duplicate exists?", !!exists);

                if (exists) {
                    console.log("⚠️ Duplicate event, skipping");
                    await session.abortTransaction();
                    return;
                }

                

                // 2. Stream Versioning (Event Sourcing)

                console.log("➡️ Updating stream...");

                const stream = await Stream.findOneAndUpdate(
                    { accountId: event.aggregateId },
                    { $inc: { lastVersion: 1 } },
                    {
                        upsert: true,
                        session,
                        returnDocument: "after"
                    }
                );

                console.log("✅ Stream updated:");
                
                

                // 3. Assemble and Persist the Immutable Event
                const fullEvent = {
                    eventId: event.eventId,
                    aggregateId: event.aggregateId,
                    eventType: event.eventType,
                    streamVersion: stream.lastVersion,
                    occurredAt: event.timestamp ?? new Date(),
                    receivedAt: new Date(),
                    payload: event.payload,
                    metadata: event.metadata ?? {}
                };

                console.log("➡️ Creating event...");

                await Event.create([fullEvent], { session });

                console.log("✅ Event created");
                // Note: updateAccount() has been entirely removed.
                // The DB transaction is solely for ensuring the event is saved safely.

                await session.commitTransaction();

                // 4. Handoff to the Queue (State Engine takes over from here)
                console.log("➡️ Queueing state event..."); 

                await this.boss.send(
                    "state-events",
                    { eventId: event.eventId },
                    { id: event.eventId }
                );

                console.log("✅ State event queued");

                return; // SUCCESS → exit retry loop

            } catch (err) {
                // Ensure we only abort if a transaction is still active
                if (session.inTransaction()) {
                    await session.abortTransaction();
                }

                const isTransientError =
                    err.message.includes("WriteConflict") ||
                    err.message.includes("TransientTransactionError") ||
                    err.message.includes("Please retry");

                if (isTransientError && attempt < MAX_RETRIES) {
                    continue; // Retry on transient MongoDB errors
                }

                // If it's a hard error or we ran out of retries, bubble it up
                throw err;

            } finally {
                // 5. Fix Session Leak: This guarantees the session closes 
                // whether the function returns early on success, aborts on duplicate, or throws an error.
                await session.endSession();
            }
        }
    }

    validate(event) {
        if (!event.eventId) {
            throw new Error("eventId missing");
        }

        if (!event.eventType) {
            throw new Error("eventType missing");
        }

        if (!event.aggregateId) {
            throw new Error("aggregateId missing");
        }

        if (!event.payload) {
            throw new Error("payload missing");
        }
    }
} 