import Account from "../accounts/account.model.js";
import { getTradingConnector } from "../connectors/trading/registry.js";
import { stageTradingAccount } from "../connectors/trading/account-provisioning.js";
import {
  ACTIVE_DEMO_STATUSES,
  FREE_TRIAL_DURATION_DAYS,
  trialMetadata,
} from "../apis/services/freeTrialPolicy.js";
import { recordAnalyticsEventOnce } from "../apis/services/analytics.service.js";

const STALE_OPERATION_MS = 5 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 60 * 1000;
const BATCH_LIMIT = 100;

export class LifecycleReconciliationWorker {
  constructor({
    accountModel = Account,
    now = () => new Date(),
    connectorResolver = getTradingConnector,
    analyticsRecorder = recordAnalyticsEventOnce,
  } = {}) {
    this.accountModel = accountModel;
    this.now = now;
    this.connectorResolver = connectorResolver;
    this.analyticsRecorder = analyticsRecorder;
    this.timer = null;
    this.running = false;
  }

  async start() {
    await this.reconcileOnce();
    this.timer = setInterval(() => {
      this.reconcileOnce().catch(error => {
        console.error("[LIFECYCLE RECONCILIATION] periodic pass failed:", error?.message || error);
      });
    }, RECONCILE_INTERVAL_MS);
    this.timer.unref?.();
    console.log("LifecycleReconciliationWorker started");
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async reconcileOnce() {
    if (this.running) return;
    this.running = true;
    try {
      await this.recoverStaleMasterApprovals();
      await this.restageInterruptedPhaseTwo();
      await this.expireDueTrials();
      await this.closeOrphanedTraderAccounts();
      await this.releaseTerminalTrialKeys();
    } finally {
      this.running = false;
    }
  }

  async recoverStaleMasterApprovals() {
    const staleBefore = new Date(this.now().getTime() - STALE_OPERATION_MS);
    const accounts = await this.accountModel.find({
      lifecycleOperationType: "MASTER_ACTIVATION",
      lifecycleOperationId: { $ne: null },
      lifecycleOperationStartedAt: { $lt: staleBefore },
    }).limit(BATCH_LIMIT);

    for (const account of accounts) {
      const operationId = account.lifecycleOperationId;
      try {
        if (account.platformAccountId) {
          await stageTradingAccount(account, {
            platformAccountId: account.platformAccountId,
            reason: "ACG_FUNDED_STALE_MASTER_ACTIVATION_RECOVERY",
          }).catch(() => {});
        }

        const current = await this.accountModel.findOne({
          _id: account._id,
          lifecycleOperationId: operationId,
        });
        if (!current) continue;

        const terminal = ["BREACHED", "CLOSED"].includes(String(current.status || "").toUpperCase());
        const record = current.platformAccounts?.find(item =>
          String(item.platformAccountId || "") === String(current.platformAccountId || "")
        );
        if (record && !["BREACHED", "CLOSED", "DISABLED"].includes(String(record.status || "").toUpperCase())) {
          record.status = "PAUSED";
        }
        if (!terminal) current.status = "FUNDED_REVIEW";
        current.enabled = false;
        current.lifecycleOperationId = null;
        current.lifecycleOperationType = null;
        current.lifecycleOperationStartedAt = null;
        current.lifecycleOperationError = terminal
          ? "Cleared stale Master activation after terminal lifecycle state."
          : "Recovered stale Master activation.";
        await current.save();
      } catch (error) {
        console.error("[LIFECYCLE RECONCILIATION] Master recovery failed", account.accountId, error?.message || error);
      }
    }
  }

  async restageInterruptedPhaseTwo() {
    const accounts = await this.accountModel.find({
      commandPending: "CREATE_PHASE_2_ACCOUNT",
      enabled: false,
      status: { $in: ["PASSED", "PHASE_2"] },
      platform: "acg-trader",
    }).limit(BATCH_LIMIT);

    for (const account of accounts) {
      const phaseTwo = account.platformAccounts?.find(item =>
        Number(item.phase) === 2
        && String(item.accountType || "").toUpperCase() !== "FUNDED"
        && String(item.status || "").toUpperCase() === "ACTIVE"
      );
      if (!phaseTwo) continue;

      try {
        await stageTradingAccount(account, {
          platformAccountId: phaseTwo.platformAccountId,
          reason: "ACG_FUNDED_INTERRUPTED_PHASE_2_RECOVERY",
        });
        phaseTwo.status = "PAUSED";
        await account.save();
      } catch (error) {
        console.error("[LIFECYCLE RECONCILIATION] Phase 2 restage failed", account.accountId, error?.message || error);
      }
    }
  }

  async expireDueTrials() {
    const now = this.now();
    const legacyCutoff = new Date(now.getTime() - FREE_TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);
    const accounts = await this.accountModel.find({
      accountMode: "DEMO",
      status: { $in: [...ACTIVE_DEMO_STATUSES] },
      $or: [
        { "trial.expiresAt": { $lte: now } },
        {
          "trial.expiresAt": { $exists: false },
          createdAt: { $lte: legacyCutoff },
        },
      ],
    }).limit(BATCH_LIMIT);

    for (const account of accounts) {
      try {
        const trial = trialMetadata(account, "EXPIRED", now);
        const expired = await this.accountModel.findOneAndUpdate(
          {
            _id: account._id,
            accountMode: "DEMO",
            status: { $in: [...ACTIVE_DEMO_STATUSES] },
          },
          {
            $set: {
              status: "EXPIRED",
              enabled: false,
              activeTrialKey: null,
              commandPending: null,
              trial,
            },
          },
          { new: true },
        );
        if (!expired) continue;

        const connector = this.connectorResolver(expired.platform);
        let changed = false;
        for (const record of expired.platformAccounts || []) {
          if (!["ACTIVE", "PAUSED"].includes(String(record.status || "").toUpperCase())) continue;
          try {
            await connector.closeAccount({
              externalRef: record.externalRef || expired.accountId,
              platformAccountId: record.platformAccountId,
              reason: "ACG_FUNDED_TRIAL_EXPIRED",
              liquidate: true,
            });
            record.status = "CLOSED";
            changed = true;
          } catch (error) {
            console.error("[LIFECYCLE RECONCILIATION] trial expiry close failed", expired.accountId, record.platformAccountId, error?.message || error);
          }
        }
        if (changed) await expired.save().catch(() => {});

        await this.analyticsRecorder({
          event: "trial_expired",
          sessionId: `account:${expired.accountId}`,
          customer: expired.customerId ? { customerId: expired.customerId } : null,
          accountId: expired.accountId,
          source: "server",
          properties: {
            ownerExternalRef: expired.ownerExternalRef,
            accountSize: expired.accountSize,
            challengeType: expired.challengeType,
          },
        }, { accountId: expired.accountId }).catch(() => {});
      } catch (error) {
        console.error("[LIFECYCLE RECONCILIATION] trial expiry failed", account.accountId, error?.message || error);
      }
    }
  }

  async closeOrphanedTraderAccounts() {
    const accounts = await this.accountModel.find({
      status: { $in: ["CLOSED", "EXPIRED"] },
      platform: "acg-trader",
      platformAccounts: { $elemMatch: { status: { $in: ["ACTIVE", "PAUSED"] } } },
    }).limit(BATCH_LIMIT);

    for (const account of accounts) {
      const connector = this.connectorResolver(account.platform);
      let changed = false;
      for (const record of account.platformAccounts || []) {
        if (!["ACTIVE", "PAUSED"].includes(String(record.status || "").toUpperCase())) continue;
        try {
          await connector.closeAccount({
            externalRef: record.externalRef || account.accountId,
            platformAccountId: record.platformAccountId,
            reason: "ACG_FUNDED_ORPHAN_RECONCILIATION",
            liquidate: true,
          });
          record.status = "CLOSED";
          changed = true;
        } catch (error) {
          console.error("[LIFECYCLE RECONCILIATION] orphan close failed", account.accountId, record.platformAccountId, error?.message || error);
        }
      }
      if (changed) await account.save().catch(() => {});
    }
  }

  async releaseTerminalTrialKeys() {
    await this.accountModel.updateMany(
      {
        accountMode: "DEMO",
        activeTrialKey: { $ne: null },
        status: { $in: ["BREACHED", "PASSED", "EXPIRED", "CLOSED"] },
      },
      { $set: { activeTrialKey: null } },
    );
  }
}

export default LifecycleReconciliationWorker;
