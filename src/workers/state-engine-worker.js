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
            async (jobOrJobs) => {
                const job = Array.isArray(jobOrJobs) ? jobOrJobs[0] : jobOrJobs;
                if (!job?.data) throw new Error("state-events worker received an invalid pg-boss job payload");
                await this.handle(job);
            }
        );

        console.log("StateEngineWorker listening on state-events");
    }

    async handle(job) {
        const { eventId } = job.data;

        if (!eventId) {
            throw new Error("eventId missing");
        }

        const event = await Event.findOne({ eventId });

        if (!event) {
            throw new Error(`Event ${eventId} not found`);
        }

        await processEvent(event, this.boss);

    }

}
