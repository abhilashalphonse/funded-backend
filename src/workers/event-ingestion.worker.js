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
        this.validate(event);
        
        
       

        const MAX_RETRIES = 3;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) { 
            // Use Event's db connection since Account is no longer imported here
            const session = await Event.db.startSession();

            try {
                session.startTransaction();

                // 1. Idempotency Guard
                const exists = await Event.findOne({
                    eventId: event.eventId
                }).session(session);


                if (exists) {
                    await session.abortTransaction();
                    return;
                }

                

                // 2. Stream Versioning (Event Sourcing)


                const stream = await Stream.findOneAndUpdate(
                    { accountId: event.aggregateId },
                    { $inc: { lastVersion: 1 } },
                    {
                        upsert: true,
                        session,
                        returnDocument: "after"
                    }
                );

                
                

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


                await Event.create([fullEvent], { session });

                // Note: updateAccount() has been entirely removed.
                // The DB transaction is solely for ensuring the event is saved safely.

                await session.commitTransaction();

                // 4. Handoff to the Queue (State Engine takes over from here)

                await this.boss.send(
                    "state-events",
                    { eventId: event.eventId }
                );


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