import { COMMAND_QUEUE_NAME } from "./state-engine/commandQueue.js";
import Account from "../accounts/account.model.js";
import simulatorEngine from "../simulator/engine.js";

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

          // Side effects are intentionally idempotent in the simulator: locking an
          // already locked account and provisioning an existing account are safe.
          const executionResult = await this.executeExternalSideEffect(command, accountId, metadata);
          await Account.updateOne({ accountId }, { $set: { commandPending: null } });

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
        await simulatorEngine.lockAccount(accountId);
        await Account.updateOne({ accountId }, { $set: { enabled: false } });
        return { success: true, timestamp: new Date(), executionType: "SIMULATOR_LOCK" };

      case "CREATE_PHASE_2_ACCOUNT":
        const account = await Account.findOne({ accountId });
        if (!account) throw new Error(`Account ${accountId} not found`);
        const simulatedAccount = await simulatorEngine.provisionAccount({
          accountId,
          balance: account.initialDeposit,
          leverage: account.leverage || 100
        });
        await Account.updateOne(
          { accountId },
          { $set: {
            currentPhase: 2,
            status: "PHASE_2",
            enabled: true,
            platformAccountId: String(simulatedAccount.login),
            login: simulatedAccount.login
          } }
        );
        return { success: true, mt5Login: simulatedAccount.login, allocatedEquity: account.initialDeposit };

      case "SEND_EMAIL_NOTIFICATION":
        console.log(`[MAILER ENGINE] Dispatching status change template digest for owner of: ${accountId}`);
        return { success: true, dispatchedAt: new Date() };

      default:
        // Fail explicitly if an engineered command isn't mapped out
        throw new Error(`[WORKER CRITICAL] Unrecognized execution directive: "${command}"`);
    }
  }

}
