import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { buildTradingPermissions } from '../connectors/trading/account-provisioning.js';

const runSchema = new mongoose.Schema({ _id: String, config: mongoose.Schema.Types.Mixed, cutoff: Date,
  cursor: mongoose.Schema.Types.ObjectId, state: String, leaseOwner: String, leaseUntil: Date }, { timestamps: true });
const resultSchema = new mongoose.Schema({ runId: String, accountObjectId: mongoose.Schema.Types.ObjectId,
  accountId: String, payload: mongoose.Schema.Types.Mixed, sourceVersion: Number, state: String, error: String }, { timestamps: true });
resultSchema.index({ runId: 1, accountObjectId: 1 }, { unique: true });
export const PermissionMigrationRun = mongoose.models.PermissionMigrationRun || mongoose.model('PermissionMigrationRun', runSchema);
export const PermissionMigrationResult = mongoose.models.PermissionMigrationResult || mongoose.model('PermissionMigrationResult', resultSchema);

export function permissionMigrationPayload(account, legacyBefore = null) {
  const terms = account.commercialTerms || {};
  const missing = typeof terms.newsTrading !== 'boolean' || typeof terms.weekendHolding !== 'boolean';
  if (missing && !(legacyBefore && account.createdAt && new Date(account.createdAt) < new Date(legacyBefore))) {
    throw new Error('MISSING_PERMISSION_HISTORY: explicit permissions or an approved historical cutoff are required');
  }
  const version = account.tradingPermissionsVersion ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('INVALID_PERMISSION_VERSION');
  return { platformAccountId: account.platformAccountId, tradingPermissions: buildTradingPermissions(account), tradingPermissionsVersion: version };
}

// Cursor advances only after an outcome is durable. Failed/pending records are retried before
// continuing the cursor, so a poison account cannot prevent other accounts from migrating.
export async function migratePermissions({ runId, config, accountModel, connector, pageSize = 200,
  runModel = PermissionMigrationRun, resultModel = PermissionMigrationResult, log = () => {} }) {
  const owner = crypto.randomUUID();
  await runModel.updateOne({ _id: runId }, { $setOnInsert: { config, cutoff: new Date(), state: 'RUNNING', leaseUntil: new Date(0) } }, { upsert: true });
  const saved = await runModel.findById(runId).lean();
  if (JSON.stringify(saved.config) !== JSON.stringify(config)) throw new Error('MIGRATION_CONFIG_CHANGED: resume with the original options');
  const leaseMs = 120000;
  const claim = { _id: runId, leaseOwner: owner };
  const run = await runModel.findOneAndUpdate({ _id: runId, leaseUntil: mongoose.trusted({ $lte: new Date() }) },
    { $set: { leaseOwner: owner, leaseUntil: new Date(Date.now() + leaseMs), state: 'RUNNING' } }, { new: true }).lean();
  if (!run) throw new Error('MIGRATION_ALREADY_RUNNING');
  async function renew() {
    const result = await runModel.updateOne({ ...claim, leaseUntil: mongoose.trusted({ $gt: new Date() }) }, { $set: { leaseUntil: new Date(Date.now() + leaseMs) } });
    if (!result.matchedCount) throw new Error('MIGRATION_LEASE_LOST');
  }
  async function processAccount(account, previous = null) {
    await renew();
    const key = { runId, accountObjectId: account._id };
    try {
      const payload = previous?.payload || permissionMigrationPayload(account, config.legacyBefore);
      if (JSON.stringify(permissionMigrationPayload(account, config.legacyBefore)) !== JSON.stringify(payload)) throw new Error('SOURCE_CHANGED_SINCE_PLAN');
      const sourceVersion = previous?.sourceVersion ?? account.tradingPermissionsVersion ?? null;
      await resultModel.updateOne(key, { $set: { accountId: account.accountId, payload, sourceVersion, state: 'PENDING', error: null } }, { upsert: true });
      if (config.apply) {
        await connector.syncChallenge(payload);
        // Only stamp the same source revision; a concurrent commercial update requires reconciliation.
        const update = await accountModel.updateOne({ _id: account._id, platformAccountId: payload.platformAccountId,
          tradingPermissionsVersion: sourceVersion,
          'commercialTerms.newsTrading': account.commercialTerms?.newsTrading ?? null,
          'commercialTerms.weekendHolding': account.commercialTerms?.weekendHolding ?? null,
        }, { $set: { tradingPermissionsVersion: payload.tradingPermissionsVersion } });
        if (!update.matchedCount) {
          const latest = await accountModel.findById(account._id).lean();
          if (JSON.stringify(permissionMigrationPayload(latest, config.legacyBefore)) !== JSON.stringify(payload)) throw new Error('SOURCE_CHANGED_DURING_SYNC');
        }
      }
      await resultModel.updateOne(key, { $set: { state: config.apply ? 'SYNCED' : 'DRY_RUN', error: null } });
      log({ accountId: account.accountId, state: config.apply ? 'SYNCED' : 'DRY_RUN' });
    } catch (error) {
      await resultModel.updateOne(key, { $set: { accountId: account.accountId, state: 'FAILED', error: String(error.code || error.message).slice(0, 1000) } }, { upsert: true });
      log({ accountId: account.accountId, state: 'FAILED', error: error.code || error.message });
    }
  }
  try {
    let retryCursor = null;
    while (true) {
      const retry = await resultModel.find({ runId, state: mongoose.trusted({ $in: ['FAILED', 'PENDING'] }),
        ...(retryCursor ? { _id: mongoose.trusted({ $gt: retryCursor }) } : {}) }).sort({ _id: 1 }).limit(pageSize).lean();
      for (const record of retry) {
        const account = await accountModel.findById(record.accountObjectId).lean();
        if (account) await processAccount(account, record);
        else await resultModel.updateOne({ _id: record._id }, { $set: { state: 'FAILED', error: 'SOURCE_ACCOUNT_MISSING' } });
        retryCursor = record._id;
      }
      if (retry.length < pageSize) break;
    }
    let cursor = run.cursor;
    while (true) {
      const page = await accountModel.find({ platform: 'acg-trader', platformAccountId: mongoose.trusted({ $nin: [null, ''] }),
        createdAt: mongoose.trusted({ $lte: run.cutoff }), ...(config.accountId ? { accountId: config.accountId } : {}),
        ...(cursor ? { _id: mongoose.trusted({ $gt: cursor }) } : {}),
      }).sort({ _id: 1 }).limit(pageSize).lean();
      for (const account of page) {
        const previous = await resultModel.findOne({ runId, accountObjectId: account._id }).lean();
        if (!['SYNCED', 'DRY_RUN'].includes(previous?.state)) await processAccount(account, previous);
        await renew();
        cursor = account._id;
        await runModel.updateOne(claim, { $set: { cursor } });
      }
      if (page.length < pageSize) break;
    }
    const failed = await resultModel.countDocuments({ runId, state: 'FAILED' });
    const state = failed ? 'NEEDS_REVIEW' : 'COMPLETED';
    await runModel.updateOne(claim, { $set: { state } });
    return { runId, state, failed, total: await resultModel.countDocuments({ runId }) };
  } finally {
    await runModel.updateOne(claim, { $set: { leaseUntil: new Date(0) }, $unset: { leaseOwner: 1 } });
  }
}
