import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { permissionMigrationPayload, isFreeTrialPermissionFallback, migratePermissions, PermissionMigrationRun, PermissionMigrationResult } from '../src/accounts/permission-migration.js';

test('permission migration keeps paid accounts strict while allowing free-trial fallback', () => {
  const paid = {
    accountId: 'ACG-PAID-1',
    accountMode: 'CHALLENGE',
    platformAccountId: 'platform-1',
    commercialTerms: {},
    createdAt: '2025-01-01T00:00:00.000Z',
  };
  assert.throws(() => permissionMigrationPayload(paid), /MISSING_PERMISSION_HISTORY/);

  const historical = permissionMigrationPayload(paid, '2026-01-01T00:00:00.000Z');
  assert.equal(historical.tradingPermissions.newsTrading, true);
  assert.equal(historical.tradingPermissions.weekendHolding, true);
  assert.equal(historical.tradingPermissionsVersion, 1);

  assert.throws(
    () => permissionMigrationPayload({ ...paid, createdAt: '2026-02-01' }, '2026-01-01T00:00:00.000Z'),
    /MISSING_PERMISSION_HISTORY/,
  );

  const trialByMode = permissionMigrationPayload({
    ...paid,
    accountId: 'legacy-demo',
    accountMode: 'DEMO',
    createdAt: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(trialByMode.tradingPermissions.newsTrading, true);
  assert.equal(trialByMode.tradingPermissions.weekendHolding, true);

  const trialById = permissionMigrationPayload({
    ...paid,
    accountId: 'TRIAL-ABC123',
    accountMode: 'CHALLENGE',
    createdAt: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(trialById.tradingPermissions.newsTrading, true);
  assert.equal(trialById.tradingPermissions.weekendHolding, true);

  const explicit = permissionMigrationPayload({
    ...paid,
    tradingPermissionsVersion: 3,
    commercialTerms: { newsTrading: false, weekendHolding: true },
  });
  assert.equal(explicit.tradingPermissions.newsTrading, false);
  assert.equal(explicit.tradingPermissions.weekendHolding, true);
  assert.equal(explicit.tradingPermissionsVersion, 3);

  assert.equal(isFreeTrialPermissionFallback({ accountMode: 'DEMO', accountId: 'anything' }), true);
  assert.equal(isFreeTrialPermissionFallback({ accountMode: 'CHALLENGE', accountId: 'TRIAL-XYZ' }), true);
  assert.equal(isFreeTrialPermissionFallback({ accountMode: 'CHALLENGE', accountId: 'ACG-PAID-1' }), false);
});

const uri = process.env.TEST_MONGODB_URI;
const FixtureAccount = mongoose.models.PermissionFixtureAccount || mongoose.model('PermissionFixtureAccount', new mongoose.Schema({
  accountId: String, accountMode: String, platform: String, platformAccountId: String, tradingPermissionsVersion: Number, commercialTerms: Object,
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


test('free Trial identifiers remain permissive without weakening paid-account validation', () => {
  for (const account of [
    { accountId: 'TRIAL-ONE', accountMode: 'DEMO' },
    { accountId: 'TRIAL-TWO', accountMode: 'CHALLENGE' },
    { accountId: 'legacy-trial', accountMode: 'DEMO' },
  ]) {
    const payload = permissionMigrationPayload({
      ...account,
      platformAccountId: 'platform-trial',
      commercialTerms: {},
      createdAt: '2026-10-05T00:00:00.000Z',
    });
    assert.equal(payload.tradingPermissions.newsTrading, true);
    assert.equal(payload.tradingPermissions.weekendHolding, true);
  }

  assert.throws(() => permissionMigrationPayload({
    accountId: 'ACG-PAID-MISSING',
    accountMode: 'CHALLENGE',
    platformAccountId: 'platform-paid',
    commercialTerms: {},
    createdAt: '2026-10-05T00:00:00.000Z',
  }), /MISSING_PERMISSION_HISTORY/);
});
