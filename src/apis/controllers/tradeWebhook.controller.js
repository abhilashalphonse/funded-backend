// controllers/tradeWebhook.controller.js

import EventService from "../services/event.service.js";

class TradeWebhookController {
    async receive(req, res, next) { 
    try {

        const trade = req.body ?? {};

        const sourceEventId = trade.eventId ?? trade.dealId ?? trade.ticket;

        if (!trade.accountId || !sourceEventId) {
            return res.status(400).json({
                success: false,
                message: "Invalid trade payload",
                received: trade
            });
        }

        const event = {
            // The broker must send a stable identifier. Generating a UUID here
            // would make a broker retry look like a new trade.
            eventId: `mt5:${trade.accountId}:${trade.eventType ?? "TRADE_RECEIVED"}:${sourceEventId}`,
            eventType: trade.eventType ?? "TRADE_RECEIVED",
            aggregateId: String(trade.accountId),
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
