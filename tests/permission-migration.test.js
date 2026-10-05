import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { permissionMigrationPayload, migratePermissions, PermissionMigrationRun, PermissionMigrationResult } from '../src/accounts/permission-migration.js';

test('permission migration rejects missing new contracts; historical fallback requires an explicit cutoff', () => {
  const account = { platformAccountId: 'platform-1', commercialTerms: {}, createdAt: '2025-01-01T00:00:00.000Z' };
  assert.throws(() => permissionMigrationPayload(account), /MISSING_PERMISSION_HISTORY/);
  const payload = permissionMigrationPayload(account, '2026-01-01T00:00:00.000Z');
  assert.equal(payload.tradingPermissions.newsTrading, true);
  assert.equal(payload.tradingPermissionsVersion, 1);
  assert.throws(() => permissionMigrationPayload({ ...account, createdAt: '2026-02-01' }, '2026-01-01T00:00:00.000Z'), /MISSING_PERMISSION_HISTORY/);
  assert.equal(permissionMigrationPayload({ ...account, tradingPermissionsVersion: 3, commercialTerms: { newsTrading: false, weekendHolding: true } }).tradingPermissionsVersion, 3);
});

const uri = process.env.TEST_MONGODB_URI;
const FixtureAccount = mongoose.models.PermissionFixtureAccount || mongoose.model('PermissionFixtureAccount', new mongoose.Schema({
  accountId: String, platform: String, platformAccountId: String, tradingPermissionsVersion: Number, commercialTerms: Object,
}, { timestamps: true }));
before(async () => {
  if (!uri) return;
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/acg_permission_test(?:\?|$)/.test(uri)) throw new Error('Dedicated local acg_permission_test replica set required');
  mongoose.set('sanitizeFilter', true);
  await mongoose.connect(uri);
  await PermissionMigrationResult.createIndexes();
});
after(async () => { if (uri) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } });

test('Mongo: migration paginates, isolates poison accounts, and resumes only incomplete work', { skip: !uri }, async () => {
  await FixtureAccount.insertMany(Array.from({ length: 205 }, (_, i) => ({ accountId: `migration-${i}`, platform: 'acg-trader', platformAccountId: `platform-${i}`,
    commercialTerms: { newsTrading: false, weekendHolding: true } })));
  let poison = true;
  const calls = new Map();
  const connector = { syncChallenge: async payload => {
    assert.equal(payload.tradingPermissionsVersion, 1);
    calls.set(payload.platformAccountId, (calls.get(payload.platformAccountId) || 0) + 1);
    if (poison && payload.platformAccountId === 'platform-7') throw new Error('simulated connector timeout');
  } };
  const args = { runId: 'resume-test', config: { apply: true, accountId: null, legacyBefore: null }, accountModel: FixtureAccount, connector, pageSize: 100 };
  const first = await migratePermissions(args);
  assert.equal(first.total, 205);
  assert.equal(first.failed, 1);
  assert.equal(first.state, 'NEEDS_REVIEW');
  assert.equal(calls.size, 205);
  poison = false;
  const second = await migratePermissions(args);
  assert.equal(second.failed, 0);
  assert.equal(second.state, 'COMPLETED');
  assert.equal(calls.get('platform-7'), 2);
  assert.equal([...calls.values()].reduce((a, b) => a + b, 0), 206);
  assert.equal(await FixtureAccount.countDocuments({ tradingPermissionsVersion: 1 }), 205);
  await assert.rejects(migratePermissions({ ...args, config: { ...args.config, apply: false } }), /MIGRATION_CONFIG_CHANGED/);
  assert.equal((await PermissionMigrationRun.findById(args.runId)).state, 'COMPLETED');
});
