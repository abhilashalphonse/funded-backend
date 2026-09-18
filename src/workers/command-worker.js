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

        const existingPhaseTwo = account.platformAccounts.find(item => Number(item.phase) === 2);
        if (Number(account.currentPhase) === 2 && account.status === "PHASE_2" && existingPhaseTwo?.status === "ACTIVE") {
          return {
            success: true,
            provider: account.platform,
            platformAccountId: existingPhaseTwo.platformAccountId,
            allocatedEquity: account.initialDeposit,
            idempotentReplay: true,
          };
        }

        const phaseOne = account.platformAccounts.find(item => Number(item.phase) === 1);
        if (phaseOne?.status !== "COMPLETED") {
          await connector.disableAccount({
            externalRef: `${account.accountId}:phase:1`,
            platformAccountId: phaseOne?.platformAccountId || account.platformAccountId,
            reason: "ACG_FUNDED_PHASE_1_COMPLETED",
            liquidate: true,
            cancelPending: true,
          });
          if (phaseOne) phaseOne.status = "COMPLETED";
          await account.save();
        }

        await provisionTradingAccount(account, { phase: 2, accountType: "CHALLENGE" });

        // Phase 2 is a fresh evaluation. Do not carry Phase 1 progress,
        // trading days, drawdown state, or trade statistics forward.
        const startingBalance = Number(account.initialDeposit || account.accountSize || 0);
        account.currentPhase = 2;
        account.status = "PHASE_2";
        account.enabled = true;
        account.balance = startingBalance;
        account.equity = startingBalance;
        account.margin = 0;
        account.marginFree = startingBalance;
        account.marginLevel = 0;
        account.floatingProfit = 0;
        account.dailyStartEquity = startingBalance;
        account.dailyResetAt = new Date();
        account.riskDayKey = null;
        account.lastActiveDay = null;
        account.lastTradingDay = null;
        account.totalTrades = 0;
        account.winningTrades = 0;
        account.losingTrades = 0;
        account.projections = {
          highestBalance: startingBalance,
          highestEquity: startingBalance,
          profit: 0,
          dailyLoss: 0,
          totalLoss: 0,
          dailyStartBalance: startingBalance,
          tradingDays: 0,
        };
        await account.save();
        return {
          success: true,
          provider: account.platform,
          platformAccountId: account.platformAccountId,
          allocatedEquity: account.initialDeposit,
        };
      }

      case "ENTER_FUNDED_REVIEW": {
        await connector.disableAccount({
          externalRef: `${account.accountId}:phase:${account.currentPhase || 1}`,
          platformAccountId: account.platformAccountId,
          reason: "ACG_FUNDED_EVALUATION_COMPLETED",
          liquidate: true,
          cancelPending: true,
        });
        account.enabled = false;
        account.status = "FUNDED_REVIEW";
        const activeRecord = account.platformAccounts.find(item => Number(item.phase) === Number(account.currentPhase || 1));
        if (activeRecord) activeRecord.status = "COMPLETED";
        await account.save();
        console.log(`[LIFECYCLE] Account ${accountId} entered funded review`);
        return { success: true, provider: account.platform, timestamp: new Date() };
      }

      default:
        throw new Error(`[WORKER CRITICAL] Unrecognized execution directive: "${command}"`);
    }
  }
}
