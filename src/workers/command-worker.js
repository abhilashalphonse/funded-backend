import { COMMAND_QUEUE_NAME } from "./state-engine/commandQueue.js";
import Event from "../events/event.model.js";
import Stream from "../events/stream.model.js";

/**
 * Worker class responsible for processing downstream side effects asynchronously.
 * Fully decoupled from state calculation; relies on emitting confirmation events.
 */
export class CommandWorker {
  /**
   * @param {Object} bossInstance - The active, bootstrapped pg-boss instance passed from server.js
   */
  constructor(bossInstance) {
    if (!bossInstance) {
      throw new Error(
        "[CommandWorker Error] Cannot instantiate CommandWorker without an active pg-boss instance."
      );
    }
    this.boss = bossInstance;
  }

  /**
   * Starts the polling loop to work off the account commands queue.
   */
  async start() {

    // Pulling batches of 5 allows concurrent processing while conserving database connections
    await this.boss.work(COMMAND_QUEUE_NAME, { batchSize: 5 }, async (jobs) => {
      for (const job of jobs) {
        const { id: jobId, data } = job;
        const { command, accountId, metadata } = data;

        try {
          console.log(`[WORKER] Processing Job ${jobId} | Command: ${command} for Account: ${accountId}`);

          // 1. DETERMINISTIC IDEMPOTENCY GUARD
          // Formulate a distinct fingerprint combining intent and the unique pg-boss tracking ID
          const operationalFingerprint = `CMD_CONFIRM_${command}_${accountId}_${jobId}`;
          
          const isAlreadyProcessed = await Event.findOne({ eventId: operationalFingerprint });
          if (isAlreadyProcessed) {
            console.log(`[WORKER IDEMPOTENCY] Command ${command} already confirmed via event log. Skipping.`);
            continue; // Safe early exit for re-delivered queue items
          }

          // 2. ISOLATED SIDE EFFECT EXECUTION
          // Third-party connections (like MT5 or Mailers) are fallible. We isolate them completely.
          const executionResult = await this.executeExternalSideEffect(command, accountId, metadata);

          // 3. TRANSACTIONAL TRANSITION EVENT EMISSION
          // Instead of modifying account status directly, emit a tracking event to the log.
          await this.emitConfirmationEvent(accountId, command, operationalFingerprint, executionResult);

          console.log(`[WORKER SUCCESS] Completed command ${command} safely for Account ${accountId}`);

        } catch (error) {
          console.error(`[WORKER CRASH] Execution failed on Job ${jobId}:`, error.message);
          
          // Throwing propagates the error back to pg-boss to trigger your backoff retry rules
          throw error; 
        }
      }
    });
  }

  /**
   * Router for external platform or infrastructure commands.
   */
  async executeExternalSideEffect(command, accountId, metadata = {}) {
    switch (command) {
      case "LOCK_ACCOUNT":
        console.log(`[MT5 GATEWAY] Executing remote account disable sequence for account: ${accountId}`);
        // Integration placeholder: return await mt5Gateway.lock(accountId);
        return { success: true, timestamp: new Date(), executionType: "API_READ_ONLY_LOCK" };

      case "CREATE_PHASE_2_ACCOUNT":
        console.log(`[MT5 GATEWAY] Provisioning new Phase 2 MetaTrader credentials for account: ${accountId}`);
        return { 
          success: true, 
          mt5Login: `MT-${Math.floor(100000 + Math.random() * 900000)}`, 
          allocatedEquity: metadata.equity || 100000 
        };

      case "SEND_EMAIL_NOTIFICATION":
        console.log(`[MAILER ENGINE] Dispatching status change template digest for owner of: ${accountId}`);
        return { success: true, dispatchedAt: new Date() };

      default:
        // Fail explicitly if an engineered command isn't mapped out
        throw new Error(`[WORKER CRITICAL] Unrecognized execution directive: "${command}"`);
    }
  }

  /**
   * Appends a tracking confirmation event to the immutable MongoDB Event Sourcing log.
   */
  async emitConfirmationEvent(accountId, baseCommand, fingerprint, executionDetails) {
    const session = await Event.db.startSession();
    
    try {
      session.startTransaction();

      // Enforce sequential event-sourcing consistency
      const stream = await Stream.findOneAndUpdate(
        { accountId },
        { $inc: { lastVersion: 1 } },
        { upsert: true, session, returnDocument: "after" }
      );

      const confirmationEvent = {
        eventId: fingerprint, // Binds the record to the queue's specific delivery identifier
        accountId,
        eventType: `${baseCommand}_CONFIRMED`,
        streamVersion: stream.lastVersion,
        payload: {
          triggeredByCommand: baseCommand,
          result: executionDetails
        },
        receivedAt: new Date()
      };

      await Event.create([confirmationEvent], { session });
      
      await session.commitTransaction();
      console.log(`[WORKER EVENT] Durable event safely recorded: ${confirmationEvent.eventType}`);

    } catch (error) {
      if (session.hasActiveTransaction) {
        const active = await session.hasActiveTransaction();
        if (active) await session.abortTransaction();
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }
}