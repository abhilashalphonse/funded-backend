import { COMMAND_QUEUE_NAME } from "./state-engine/commandQueue.js";
import Account from "../accounts/account.model.js";
import { getTradingConnector } from "../connectors/trading/registry.js";
import { provisionTradingAccount } from "../connectors/trading/account-provisioning.js";
import { ensureTradingCredential } from "../trading-credentials/trading-credential.service.js";
import { recordAnalyticsEventOnce } from "../apis/services/analytics.service.js";
import { applyPlatformAccountState, phaseCompletionState, resetAccountForPhaseTwo as resetPhaseTwoState, tradablePhaseStatus } from "../accounts/account-lifecycle.js";

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
        if (isActivePhaseTwo(account)) {
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
          const check = await finalizeCurrentPhase(account, connector, {
            phase: 1,
            record: phaseOne,
            reason: "ACG_FUNDED_PHASE_1_COMPLETION_CHECK",
          });
          if (!check.passed) return check;
        }

        const nextPhaseAccountType = phaseAccountType(account);
        await provisionTradingAccount(account, { phase: 2, accountType: nextPhaseAccountType });
        await ensureTradingCredential(account, { queueEmail: true, platformAccountId: account.platformAccountId });

        resetAccountForPhaseTwo(account);
        await account.save();

        if (account.accountMode !== "DEMO") {
          await recordAnalyticsEventOnce({
            event: "phase_2_started",
            sessionId: `account:${account.accountId}`,
            accountId: account.accountId,
            source: "server",
            properties: {
              ownerExternalRef: account.ownerExternalRef,
              accountSize: account.accountSize,
              challengeType: account.challengeType,
              phase: 2,
            },
          }, { accountId: account.accountId }).catch(() => {});
        }

        return {
          success: true,
          provider: account.platform,
          platformAccountId: account.platformAccountId,
          allocatedEquity: account.initialDeposit,
        };
      }

      case "COMPLETE_TRIAL": {
        await connector.disableAccount({
          externalRef: `${account.accountId}:phase:${account.currentPhase || 1}`,
          platformAccountId: account.platformAccountId,
          reason: "ACG_FUNDED_TRIAL_COMPLETED",
          liquidate: true,
          cancelPending: true,
        });
        account.enabled = false;
        account.status = "PASSED";
        const activeRecord = account.platformAccounts.find(item =>
          Number(item.phase) === Number(account.currentPhase || 1)
          && String(item.accountType || "DEMO").toUpperCase() === "DEMO"
        );
        if (activeRecord) activeRecord.status = "COMPLETED";
        await account.save();
        console.log(`[LIFECYCLE] Trial ${accountId} completed successfully`);
        return { success: true, provider: account.platform, timestamp: new Date() };
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


async function finalizeCurrentPhase(account, connector, { phase, record, reason }) {
  if (typeof connector.flattenAccount !== "function") {
    const error = new Error("Trading provider does not support phase finalization.");
    error.code = "TRADING_PROVIDER_FLATTEN_UNSUPPORTED";
    throw error;
  }

  const platformAccountId = String(record?.platformAccountId || account.platformAccountId || "").trim();
  if (!platformAccountId) {
    const error = new Error("Current trading platform account is missing.");
    error.code = "TRADING_PLATFORM_ACCOUNT_MISSING";
    throw error;
  }

  await connector.flattenAccount({ platformAccountId, reason });
  const remote = await connector.getAccount({ platformAccountId });
  applyPlatformAccountState(account, remote?.raw || {});
  const check = phaseCompletionState(account, { balance: account.balance, equity: account.equity }, phase);

  if (!check.passed) {
    await connector.resumeAccount({
      platformAccountId,
      reason: "ACG_FUNDED_PHASE_RECHECK_FAILED",
    });
    if (record) record.status = "ACTIVE";
    account.status = tradablePhaseStatus(account, phase);
    account.enabled = true;
    account.commandPending = null;
    await account.save();
    return { success: false, passed: false, revalidationFailed: true, completion: check };
  }

  await connector.disableAccount({
    platformAccountId,
    reason: "ACG_FUNDED_PHASE_RESULT_CONFIRMED",
    liquidate: false,
    cancelPending: true,
  });
  if (record) record.status = "COMPLETED";
  await account.save();
  return { success: true, passed: true, platformAccountId, completion: check };
}


export function phaseAccountType(account) {
  return String(account?.accountMode || "").toUpperCase() === "DEMO" ? "DEMO" : "CHALLENGE";
}

export function isActivePhaseTwo(account) {
  const phaseTwo = account?.platformAccounts?.find(item => Number(item.phase) === 2);
  return Number(account?.currentPhase) === 2 && account?.status === "PHASE_2" && phaseTwo?.status === "ACTIVE";
}

export function resetAccountForPhaseTwo(account, now = new Date()) {
  return resetPhaseTwoState(account, now);
}
