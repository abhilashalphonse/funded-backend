import EventService from "../services/event.service.js";
import Account from "../../accounts/account.model.js";
import accountSnapshotService, { platformAccountMatches } from "../services/accountSnapshot.service.js";
import { verifyACGTraderWebhook } from "../../connectors/acg-trader/webhook-signature.js";

const SNAPSHOT_EVENT = "ACG_TRADER_ACCOUNT_SNAPSHOT";
const SUPPORTED_EVENT_TYPES = new Set([
  SNAPSHOT_EVENT,
  "ACG_TRADER_DEAL_CREATED",
  "ACG_TRADER_ACCOUNT_CONTROLLED",
]);

class ACGTraderWebhookController {
  async receive(req, res, next) {
    try {
      const envelope = req.body ?? {};
      verifyACGTraderWebhook({
        secret: process.env.ACG_TRADER_WEBHOOK_SECRET,
        timestamp: req.headers["x-acg-event-timestamp"],
        signature: req.headers["x-acg-event-signature"],
        body: envelope,
      });
      validateEnvelope(envelope);

      const event = {
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        aggregateId: String(envelope.aggregateId),
        timestamp: new Date(envelope.timestamp),
        payload: envelope.payload,
        metadata: { ...(envelope.metadata || {}), provider: "acg-trader" },
      };

      if (event.eventType === SNAPSHOT_EVENT) {
        const authorization = await accountSnapshotService.authorize(
          event.aggregateId,
          envelope.payload.platformAccountId,
        );

        if (!authorization.exists) {
          return res.status(404).json({ success: false, message: "Funded account not found" });
        }
        if (!authorization.matches) {
          return res.status(409).json({
            success: false,
            message: "Platform account does not belong to funded account",
            code: "PLATFORM_ACCOUNT_MISMATCH",
          });
        }

        const result = await accountSnapshotService.receive(event);
        return res.status(202).json({
          success: true,
          eventId: event.eventId,
          accepted: result.accepted,
          stale: result.stale,
          degraded: result.degraded,
        });
      }

      const account = await Account.findOne({ accountId: event.aggregateId }).lean();
      if (!account) return res.status(404).json({ success: false, message: "Funded account not found" });
      if (!platformAccountMatches(account, envelope.payload.platformAccountId)) {
        return res.status(409).json({
          success: false,
          message: "Platform account does not belong to funded account",
          code: "PLATFORM_ACCOUNT_MISMATCH",
        });
      }

      await EventService.receive(event);
      return res.status(202).json({ success: true, eventId: event.eventId });
    } catch (error) {
      next(error);
    }
  }
}

function validateEnvelope(envelope) {
  if (!String(envelope.eventId || "").startsWith("acg-trader:")) throw invalid("eventId");
  if (!SUPPORTED_EVENT_TYPES.has(String(envelope.eventType || ""))) throw invalid("eventType");
  if (!String(envelope.aggregateId || "").trim()) throw invalid("aggregateId");
  if (!envelope.timestamp || Number.isNaN(new Date(envelope.timestamp).getTime())) throw invalid("timestamp");
  if (!envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) throw invalid("payload");
  if (envelope.payload.provider !== "acg-trader") throw invalid("payload.provider");
  if (!String(envelope.payload.platformAccountId || "").trim()) throw invalid("payload.platformAccountId");
}

function invalid(field) {
  const error = new Error(`Invalid ACG Trader webhook ${field}`);
  error.status = 400;
  error.code = "ACG_TRADER_WEBHOOK_INVALID";
  return error;
}

export { validateEnvelope, platformAccountMatches };
export default new ACGTraderWebhookController();
