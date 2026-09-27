import mongoose from "mongoose";
import { connectDatabase } from "../src/config/database.js";
import {
  ACG_FUNDED_V2_MIGRATION_ID,
  auditAndMigrateFundedRiskPolicyV2,
} from "../src/maintenance/fundedRiskPolicyV2.js";
import {
  resolveMigrationEnvironment,
  validateV2MigrationSafety,
} from "../src/maintenance/fundedRiskPolicyV2Safety.js";

const apply = process.argv.includes("--apply");
const migrationId = argValue("--migration-id") || ACG_FUNDED_V2_MIGRATION_ID;
const fundedAccountId = argValue("--funded-account-id") || null;
const platformAccountId = argValue("--platform-account-id") || null;
const afterPlatformAccountId = argValue("--after") || null;
const allowBulk = process.argv.includes("--allow-bulk");
const allowProduction = process.argv.includes("--allow-production");
const limitRaw = argValue("--limit");
const limit = limitRaw == null ? null : Number(limitRaw);

if (limitRaw != null && (!Number.isInteger(limit) || limit <= 0)) {
  console.error("[ACG_FUNDED_RISK_POLICY_V2] FAILED", {
    code: "INVALID_LIMIT",
    message: "--limit must be a positive integer.",
  });
  process.exit(1);
}

const mode = apply ? "APPLY" : "DRY_RUN";

try {
  const safety = validateV2MigrationSafety({
    apply,
    fundedAccountId,
    platformAccountId,
    allowBulk,
    allowProduction,
    environmentName: resolveMigrationEnvironment(),
  });

  console.log(`[ACG_FUNDED_RISK_POLICY_V2] ${mode} SAFETY ${JSON.stringify({
    environment: safety.environmentName,
    targeted: safety.targeted,
    fundedAccountId: safety.fundedAccountId,
    platformAccountId: safety.platformAccountId,
    allowBulk: safety.allowBulk,
    allowProduction: safety.allowProduction,
  })}`);

  await connectDatabase();
  const result = await auditAndMigrateFundedRiskPolicyV2({
    apply,
    migrationId,
    fundedAccountId,
    platformAccountId,
    afterPlatformAccountId,
    limit,
  });

  console.log(`[ACG_FUNDED_RISK_POLICY_V2] ${mode} SUMMARY ${JSON.stringify({
    migrationId: result.migrationId,
    fundedAccountId: result.fundedAccountId,
    platformAccountId: result.platformAccountId,
    nextCursor: result.nextCursor,
    ...result.summary,
  })}`);

  for (const record of result.records) {
    console.log(`[ACG_FUNDED_RISK_POLICY_V2] ${mode} ACCOUNT ${JSON.stringify({
      fundedAccountId: record.fundedAccountId,
      platformAccountId: record.platformAccountId,
      accountType: record.accountType,
      traderStatus: record.traderStatus,
      riskPolicyVersionBefore: record.before?.riskPolicyVersion || record.riskPolicyVersion,
      action: record.action,
      eligible: record.before?.eligible ?? record.eligible,
      alreadyV2: record.before?.alreadyV2 ?? record.alreadyV2,
      ineligibleReason: record.before?.ineligibleReason ?? record.ineligibleReason,
      migrated: record.migrated,
      verified: record.verified,
      idempotentReplay: record.idempotentReplay || false,
      riskPolicyVersionAfter: record.riskPolicyVersion,
      missingAfter: record.missing,
      mismatchesAfter: record.mismatches,
      concurrentFinancialChange: record.verification?.concurrentFinancialChange || false,
      transitionMigrationId: record.transitionForMigration?.migrationId || record.verification?.transition?.migrationId || null,
    })}`);
  }

  if (apply && (
    result.summary.accountsNeedingManualReview > 0
    || result.summary.accountsWithVerificationFailure > 0
  )) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error("[ACG_FUNDED_RISK_POLICY_V2] FAILED", {
    code: error?.code,
    message: error?.message,
    details: error?.details,
  });
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}

function argValue(name) {
  const prefixed = process.argv.find(value => value.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1];
  }
  return null;
}
