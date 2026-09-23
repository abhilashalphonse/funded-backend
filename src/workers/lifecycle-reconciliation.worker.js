import Account from "../accounts/account.model.js";
import { getTradingConnector } from "../connectors/trading/registry.js";
import { stageTradingAccount } from "../connectors/trading/account-provisioning.js";

const STALE_OPERATION_MS = 5 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 60 * 1000;
const BATCH_LIMIT = 100;

export class LifecycleReconciliationWorker {
  constructor({ accountModel = Account, now = () => new Date() } = {}) {
    this.accountModel = accountModel;
    this.now = now;
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

        const record = current.platformAccounts?.find(item =>
          String(item.platformAccountId || "") === String(current.platformAccountId || "")
        );
        if (record && !["BREACHED", "CLOSED", "DISABLED"].includes(String(record.status || "").toUpperCase())) {
          record.status = "PAUSED";
        }
        current.status = "FUNDED_REVIEW";
        current.enabled = false;
        current.lifecycleOperationId = null;
        current.lifecycleOperationType = null;
        current.lifecycleOperationStartedAt = null;
        current.lifecycleOperationError = "Recovered stale Master activation.";
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

  async closeOrphanedTraderAccounts() {
    const accounts = await this.accountModel.find({
      status: "CLOSED",
      platform: "acg-trader",
      platformAccounts: { $elemMatch: { status: { $in: ["ACTIVE", "PAUSED"] } } },
    }).limit(BATCH_LIMIT);

    for (const account of accounts) {
      const connector = getTradingConnector(account.platform);
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
        status: { $in: ["BREACHED", "PASSED", "CLOSED"] },
      },
      { $set: { activeTrialKey: null } },
    );
  }
}

export default LifecycleReconciliationWorker;
