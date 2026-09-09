// controllers/tradeWebhook.controller.js

import { randomUUID } from "crypto";
import EventService from "../services/event.service.js";

class TradeWebhookController {
    async receive(req, res, next) { 
    try {

        const trade = req.body ?? {};

        if (!trade.accountId || !trade.ticket) {
            return res.status(400).json({
                success: false,
                message: "Invalid trade payload",
                received: trade
            });
        }

        const event = {
            eventId: randomUUID(),
            eventType: "TRADE_RECEIVED",
            aggregateId: trade.accountId,
            timestamp: new Date(),
            payload: trade
        };

        await EventService.receive(event);

        return res.status(202).json({
            success: true,
            eventId: event.eventId
        });

    } catch (err) {
        next(err);
    }
}
}

export default new TradeWebhookController();