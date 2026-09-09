import Event from "../events/event.model.js";
import { processEvent } from "./state-engine/processEvent.js";

export default class StateEngineWorker {
    constructor(boss) {
        this.boss = boss;
    }
    

    async start() {
        console.log("Starting StateEngineWorker...");

        await this.boss.work(
            "state-events",
            async (jobs) => {
                const job = jobs[0];

                console.log(
                    "STATE EVENT RECEIVED"
                );

                await this.handle(job);
            }
        );

        console.log("StateEngineWorker listening on state-events");
    }

    async handle(job) {
        console.log("Processing state job:");

        const { eventId } = job.data;

        console.log("Looking up event:", eventId);

        if (!eventId) {
            throw new Error("eventId missing");
        }

        const event = await Event.findOne({ eventId });

        console.log("Mongo event:");

        if (!event) {
            throw new Error(`Event ${eventId} not found`);
        }

        await processEvent(event, this.boss);

        console.log(
            `[STATE] processed ${event.eventId} (${event.eventType})`
        );
    }

}
