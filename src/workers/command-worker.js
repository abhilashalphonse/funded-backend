import { COMMAND_QUEUE_NAME } from "./state-engine/commandQueue.js";
import Account from "../accounts/account.model.js";
import { getTradingConnector } from "../connectors/trading/registry.js";
import { provisionTradingAccount } from "../connectors/trading/account-provisioning.js";

export class CommandWorker {
  constructor(bossInstance) {
    if (!bossInstance) {
      throw new Error("[CommandWorker Error] Cannot instantiate CommandWorker without an active pg-boss instance.");
    }
    this.boss = bossInstance;
  }

  async start() {
    await this.boss.work(COMMAND_QUEUE_NAME, { batchSize: 5 }, async (jobs) => {
      for (const job of jobs) {
        const { id: jobId, data } = job;
        const { command, accountId, metadata } = data;

        try {
          console.log(`[WORKER] Processing Job ${jobId} | Command: ${command} for Account: ${accountId}`);
          await this.executeExternalSideEffect(command, accountId, metadata);
          await Account.updateOne({ accountId }, { $set: { commandPending: null } });
          console.log(`[WORKER SUCCESS] Completed command ${command} safely for Account ${accountId}`);
        } catch (error) {
          console.error(`[WORKER CRASH] Execution failed on Job ${jobId}:`, error.message);
          throw error;
        }
      }
    });
  }

  async executeExternalSideEffect(command, accountId, metadata = {}) {
    const account = await Account.findOne({ accountId });
    if (!account) throw new Error(`Account ${accountId} not found`);
    const connector = getTradingConnector(account.platform);

    switch (command) {
      case "LOCK_ACCOUNT":
        await connector.breachAccount({
          externalRef: `${account.accountId}:phase:${account.currentPhase || 1}`,
          platformAccountId: account.platformAccountId,
          reason: "ACG_FUNDED_RISK_BREACH",
          action: "LIQUIDATE_AND_LOCK",
        });
        await Account.updateOne({ accountId }, { $set: { enabled: false } });
        return { success: true, provider: account.platform, timestamp: new Date() };

      case "CREATE_PHASE_2_ACCOUNT": {
        if (account.challengeType !== "TWO_STEP") {
          throw new Error(`Account ${accountId} is not a two-step challenge`);
        }
        await provisionTradingAccount(account, { phase: 2, accountType: "CHALLENGE" });
        account.currentPhase = 2;
        account.status = "PHASE_2";
        account.enabled = true;
        await account.save();
        return {
          success: true,
          provider: account.platform,
          platformAccountId: account.platformAccountId,
          allocatedEquity: account.initialDeposit,
        };
      }

      case "SEND_EMAIL_NOTIFICATION":
        console.log(`[MAILER ENGINE] Dispatching status change template digest for owner of: ${accountId}`);
        return { success: true, dispatchedAt: new Date() };

      default:
        throw new Error(`[WORKER CRITICAL] Unrecognized execution directive: "${command}"`);
    }
  }
}
