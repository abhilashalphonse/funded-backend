import mongoose from "mongoose";
import { connectDatabase } from "../src/config/database.js";
import {
  auditAndMigrateFundedRiskPolicyV1,
  validateV1RepairSafety,
} from "../src/maintenance/fundedRiskPolicyV1.js";
import { resolveMigrationEnvironment } from "../src/maintenance/fundedRiskPolicyV2Safety.js";

const apply = process.argv.includes("--apply");
const fundedAccountId = argValue("--funded-account-id") || null;
const platformAccountId = argValue("--platform-account-id") || null;
const allowProduction = process.argv.includes("--allow-production");
const mode = apply ? "APPLY" : "AUDIT";

try {
  const safety = validateV1RepairSafety({
    apply,
    fundedAccountId,
    platformAccountId,
    allowProduction,
    environmentName: resolveMigrationEnvironment(),
  });

  console.log(`[ACG_FUNDED_RISK_POLICY_V1] ${mode} SAFETY ${JSON.stringify({
    environment: safety.environmentName,
    targeted: safety.targeted,
    fundedAccountId: safety.fundedAccountId,
    platformAccountId: safety.platformAccountId,
    allowProduction: safety.allowProduction,
  })}`);

  await connectDatabase();
  const result = await auditAndMigrateFundedRiskPolicyV1({
    apply,
    fundedAccountId: safety.fundedAccountId,
    platformAccountId: safety.platformAccountId,
  });

  console.log(`[ACG_FUNDED_RISK_POLICY_V1] ${mode} SUMMARY ${JSON.stringify({
    fundedAccountId: result.fundedAccountId,
    platformAccountId: result.platformAccountId,
    ...result.summary,
  })}`);

  for (const record of result.records) {
    const before = record.before || record;
    if (
      before.missing?.length
      || before.mismatches?.length
      || before.openWithoutStopLoss?.length
      || before.riskPolicyVersion !== result.version
      || record.migrated
    ) {
      console.log(`[ACG_FUNDED_RISK_POLICY_V1] ${mode} ACCOUNT ${JSON.stringify({
        fundedAccountId: record.fundedAccountId,
        platformAccountId: record.platformAccountId,
        traderStatus: record.traderStatus,
        riskPolicyVersionBefore: before.riskPolicyVersion,
        missingBefore: before.missing,
        mismatchesBefore: before.mismatches,
        openWithoutStopLoss: before.openWithoutStopLoss,
        migrated: record.migrated,
        riskPolicyVersionAfter: record.riskPolicyVersion,
        missingAfter: record.missing,
        mismatchesAfter: record.mismatches,
      })}`);
    }
  }

  if (apply && (
    result.summary.accountsWithPolicyMismatchAfter > 0
    || result.summary.accountsWithVersionMismatchAfter > 0
  )) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error("[ACG_FUNDED_RISK_POLICY_V1] FAILED", {
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
