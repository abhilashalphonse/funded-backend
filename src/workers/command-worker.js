import { COMMAND_QUEUE_NAME, CommandQueue } from "./state-engine/commandQueue.js";
import Account from "../accounts/account.model.js";
import { getTradingConnector } from "../connectors/trading/registry.js";
import { activateTradingAccount, provisionTradingAccount, stageTradingAccount } from "../connectors/trading/account-provisioning.js";
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
    await this.recoverPendingCommands();
    await this.boss.work(COMMAND_QUEUE_NAME, { batchSize: 5 }, async (jobs) => {
      for (const job of jobs) {
        const { id: jobId, data } = job;
        const { command, accountId, metadata } = data;

        try {
          console.log(`[WORKER] Processing Job ${jobId} | Command: ${command} for Account: ${accountId}`);
          await this.executeExternalSideEffect(command, accountId, metadata);
          await Account.updateOne(
            { accountId, commandPending: command },
            { $set: { commandPending: null } },
          );
          console.log(`[WORKER SUCCESS] Completed command ${command} safely for Account ${accountId}`);
        } catch (error) {
          console.error(`[WORKER CRASH] Execution failed on Job ${jobId}:`, error.message);
          throw error;
        }
      }
    });
  }

  async recoverPendingCommands() {
    const pending = await Account.find({
      commandPending: { $in: ["LOCK_ACCOUNT", "CREATE_PHASE_2_ACCOUNT", "COMPLETE_TRIAL", "ENTER_FUNDED_REVIEW"] },
    }).select("accountId commandPending").limit(500).lean();

    const queue = new CommandQueue(this.boss);
    for (const account of pending) {
      await queue.enqueueCommand(account.commandPending, account).catch(error => {
        console.error("[WORKER RECOVERY] Failed to requeue lifecycle command", account.accountId, error?.message || error);
      });
    }
  }

  async executeExternalSideEffect(command, accountId, metadata = {}) {
    let account = await Account.findOne({ accountId });
    if (!account) throw new Error(`Account ${accountId} not found`);
    if (!commandStillValid(account, command)) {
      return { success: true, skipped: true, staleCommand: true, command };
    }
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
        const staged = account.platform === "acg-trader";
        await provisionTradingAccount(account, {
          phase: 2,
          accountType: nextPhaseAccountType,
          activate: !staged,
        });

        // Commit the new lifecycle generation before the Trader account becomes
        // tradable or federation-visible.
        resetAccountForPhaseTwo(account);
        account.enabled = !staged;
        if (staged) account.commandPending = "CREATE_PHASE_2_ACCOUNT";
        await account.save();

        if (staged) {
          try {
            await activateTradingAccount(account, {
              reason: "ACG_FUNDED_PHASE_2_LIFECYCLE_COMMITTED",
            });
            const activated = await Account.findOneAndUpdate(
              {
                _id: account._id,
                status: "PHASE_2",
                commandPending: "CREATE_PHASE_2_ACCOUNT",
                customerAccessBlocked: { $ne: true },
              },
              {
                $set: {
                  enabled: true,
                  "platformAccounts.$[target].status": "ACTIVE",
                },
              },
              {
                new: true,
                arrayFilters: [{ "target.platformAccountId": account.platformAccountId }],
              },
            );
            if (!activated) {
              const superseded = new Error("Phase 2 activation was superseded by a newer lifecycle state.");
              superseded.code = "PHASE_2_ACTIVATION_SUPERSEDED";
              throw superseded;
            }
            account = activated;
          } catch (error) {
            await stageTradingAccount(account, {
              reason: "ACG_FUNDED_PHASE_2_ACTIVATION_FAILED",
            }).catch(() => {});
            account.enabled = false;
            account.commandPending = "CREATE_PHASE_2_ACCOUNT";
            await account.save().catch(() => {});
            throw error;
          }
        }

        await ensureTradingCredential(account, {
          queueEmail: true,
          platformAccountId: account.platformAccountId,
        }).catch(() => {});

        if (account.accountMode === "DEMO") {
          await recordAnalyticsEventOnce({
            event: "trial_phase_1_passed",
            sessionId: `account:${account.accountId}`,
            accountId: account.accountId,
            source: "server",
            properties: {
              ownerExternalRef: account.ownerExternalRef,
              accountSize: account.accountSize,
              challengeType: account.challengeType,
              completedPhase: 1,
            },
          }, { accountId: account.accountId }).catch(() => {});
        } else {
          await recordAnalyticsEventOnce({
            event: "phase_1_passed",
            sessionId: `account:${account.accountId}`,
            accountId: account.accountId,
            source: "server",
            properties: { ownerExternalRef: account.ownerExternalRef, accountSize: account.accountSize, challengeType: account.challengeType },
          }, { accountId: account.accountId }).catch(() => {});

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
        const phase = Number(account.currentPhase || 1);
        const activeRecord = account.platformAccounts.find(item =>
          Number(item.phase) === phase
          && String(item.accountType || "DEMO").toUpperCase() === "DEMO"
        );
        if (activeRecord?.status !== "COMPLETED") {
          const check = await finalizeCurrentPhase(account, connector, {
            phase,
            record: activeRecord,
            reason: "ACG_FUNDED_TRIAL_COMPLETION_CHECK",
          });
          if (!check.passed) return check;
        }
        account.enabled = false;
        account.status = "PASSED";
        account.activeTrialKey = null;
        if (activeRecord) activeRecord.status = "COMPLETED";
        await account.save();

        const properties = {
          ownerExternalRef: account.ownerExternalRef,
          accountSize: account.accountSize,
          challengeType: account.challengeType,
          completedPhase: phase,
        };
        await recordAnalyticsEventOnce({
          event: "trial_passed",
          sessionId: `account:${account.accountId}`,
          accountId: account.accountId,
          source: "server",
          properties,
        }, { accountId: account.accountId }).catch(() => {});
        await recordAnalyticsEventOnce({
          event: "trial_completed",
          sessionId: `account:${account.accountId}`,
          accountId: account.accountId,
          source: "server",
          properties,
        }, { accountId: account.accountId }).catch(() => {});

        console.log(`[LIFECYCLE] Trial ${accountId} completed successfully`);
        return { success: true, provider: account.platform, timestamp: new Date() };
      }

      case "ENTER_FUNDED_REVIEW": {
        const phase = Number(account.currentPhase || 1);
        const activeRecord = account.platformAccounts.find(item =>
          Number(item.phase) === phase
          && String(item.accountType || "CHALLENGE").toUpperCase() === "CHALLENGE"
        );
        if (activeRecord?.status !== "COMPLETED") {
          const check = await finalizeCurrentPhase(account, connector, {
            phase,
            record: activeRecord,
            reason: "ACG_FUNDED_FINAL_PHASE_COMPLETION_CHECK",
          });
          if (!check.passed) return check;
        }
        account.enabled = false;
        account.status = "FUNDED_REVIEW";
        if (activeRecord) activeRecord.status = "COMPLETED";
        await account.save();
        await recordAnalyticsEventOnce({ event: "evaluation_passed", sessionId: `account:${account.accountId}`, accountId: account.accountId, source: "server", properties: { ownerExternalRef: account.ownerExternalRef, accountSize: account.accountSize, challengeType: account.challengeType, completedPhase: phase } }, { accountId: account.accountId }).catch(() => {});

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
  const raw = remote?.raw || {};
  const remoteStatus = String(raw?.status || raw?.account?.status || "").toUpperCase();

  applyPlatformAccountState(account, raw);

  if (remoteStatus === "BREACHED") {
    if (record) record.status = "BREACHED";
    account.status = "BREACHED";
    account.enabled = false;
    account.commandPending = null;
    if (account.accountMode === "DEMO") account.activeTrialKey = null;
    await account.save();
    return { success: false, passed: false, breached: true, platformAccountId };
  }

  if (remoteStatus === "CLOSED") {
    if (record) record.status = "CLOSED";
    account.status = "CLOSED";
    account.enabled = false;
    account.commandPending = null;
    if (account.accountMode === "DEMO") account.activeTrialKey = null;
    await account.save();
    return { success: false, passed: false, closed: true, platformAccountId };
  }

  const check = phaseCompletionState(account, { balance: account.balance, equity: account.equity }, phase);

  if (!check.passed) {
    if (remoteStatus === "DISABLED") {
      const error = new Error("Disabled phase account no longer satisfies the confirmed completion target.");
      error.code = "PHASE_FINALIZATION_STATE_CONFLICT";
      throw error;
    }
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

  if (remoteStatus !== "DISABLED") {
    await connector.disableAccount({
      platformAccountId,
      reason: "ACG_FUNDED_PHASE_RESULT_CONFIRMED",
      liquidate: false,
      cancelPending: true,
    });
  }

  if (record) record.status = "COMPLETED";
  await account.save();
  return {
    success: true,
    passed: true,
    platformAccountId,
    completion: check,
    idempotentRemoteFinalization: remoteStatus === "DISABLED",
  };
}

export function commandStillValid(account, command) {
  if (!account || String(account.commandPending || "") !== String(command || "")) return false;
  const status = String(account.status || "").toUpperCase();

  if (command === "LOCK_ACCOUNT") return status === "BREACHED";
  if (command === "CREATE_PHASE_2_ACCOUNT") {
    return account.challengeType === "TWO_STEP" && ["PASSED", "PHASE_2"].includes(status);
  }
  if (command === "COMPLETE_TRIAL") return account.accountMode === "DEMO" && status === "PASSED";
  if (command === "ENTER_FUNDED_REVIEW") return status === "FUNDED_REVIEW";
  return false;
}

export function phaseAccountType(account) {
  return String(account?.accountMode || "").toUpperCase() === "DEMO" ? "DEMO" : "CHALLENGE";
}

export function isActivePhaseTwo(account) {
  const phaseTwo = account?.platformAccounts?.find(item => Number(item.phase) === 2);
  return Number(account?.currentPhase) === 2
    && account?.status === "PHASE_2"
    && account?.enabled === true
    && phaseTwo?.status === "ACTIVE";
}

export function resetAccountForPhaseTwo(account, now = new Date()) {
  return resetPhaseTwoState(account, now);
}
