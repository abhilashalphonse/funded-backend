// apis/services/event.service.js

import boss from "../../config/boss.js";

class EventService {
    async receive(event) {
        // Keep the provider/domain event ID in the payload. pg-boss should
        // generate its own UUID job ID; domain IDs such as
        // "acg-trader:<uuid>" are not pg-boss job identifiers.
        await boss.send("incoming-events", event);
        return event;
    }
}

export default new EventService();
