// apis/services/event.service.js

import boss from "../../config/boss.js";


class EventService {

    async receive(event) {

        await boss.send( 
            "incoming-events",
            event,
            {
                id: event.eventId
            }
        );

        return event; 
    }

}


export default new EventService();