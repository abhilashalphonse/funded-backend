import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveMigrationEnvironment,
  validateV2MigrationSafety,
} from "../../src/maintenance/fundedRiskPolicyV2Safety.js";

test("dry-run remains read-only and may audit broadly", () => {
  const result = validateV2MigrationSafety({
    apply: false,
    environmentName: "production",
  });
  assert.equal(result.apply, false);
  assert.equal(result.production, true);
  assert.equal(result.targeted, false);
});

test("apply requires an exact account unless bulk rollout is explicitly approved", () => {
  assert.throws(
    () => validateV2MigrationSafety({
      apply: true,
      environmentName: "staging",
    }),
    error => error?.code === "ACG_FUNDED_V2_APPLY_REQUIRES_TARGET",
  );

  const targeted = validateV2MigrationSafety({
    apply: true,
    environmentName: "staging",
    platformAccountId: "trader-1",
  });
  assert.equal(targeted.targeted, true);
  assert.equal(targeted.platformAccountId, "trader-1");
});

test("production V2 apply requires a separate explicit production acknowledgement", () => {
  assert.throws(
    () => validateV2MigrationSafety({
      apply: true,
      environmentName: "production",
      platformAccountId: "trader-1",
    }),
    error => error?.code === "ACG_FUNDED_V2_PRODUCTION_APPLY_BLOCKED",
  );

  const approved = validateV2MigrationSafety({
    apply: true,
    environmentName: "production",
    platformAccountId: "trader-1",
    allowProduction: true,
  });
  assert.equal(approved.production, true);
  assert.equal(approved.allowProduction, true);
});

test("bulk apply and production acknowledgement are independent safeguards", () => {
  assert.throws(
    () => validateV2MigrationSafety({
      apply: true,
      environmentName: "production",
      allowBulk: true,
    }),
    error => error?.code === "ACG_FUNDED_V2_PRODUCTION_APPLY_BLOCKED",
  );

  const bulkStaging = validateV2MigrationSafety({
    apply: true,
    environmentName: "staging",
    allowBulk: true,
  });
  assert.equal(bulkStaging.targeted, false);
  assert.equal(bulkStaging.allowBulk, true);
});

test("conflicting exact selectors are always rejected", () => {
  assert.throws(
    () => validateV2MigrationSafety({
      apply: false,
      fundedAccountId: "ACG-1",
      platformAccountId: "trader-1",
    }),
    error => error?.code === "ACG_FUNDED_V2_SELECTOR_CONFLICT",
  );
});

test("Railway environment name takes precedence when resolving migration environment", () => {
  assert.equal(resolveMigrationEnvironment({
    RAILWAY_ENVIRONMENT_NAME: "staging",
    NODE_ENV: "production",
  }), "staging");
});
