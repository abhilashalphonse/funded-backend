import mongoose from "mongoose";
import { connectDatabase } from "../src/config/database.js";
import { auditAndMigrateFundedRiskPolicyV1 } from "../src/maintenance/fundedRiskPolicyV1.js";

const apply = process.argv.includes("--apply");
const mode = apply ? "APPLY" : "AUDIT";

try {
  await connectDatabase();
  const result = await auditAndMigrateFundedRiskPolicyV1({ apply });

  console.log(`[ACG_FUNDED_RISK_POLICY_V1] ${mode} SUMMARY ${JSON.stringify(result.summary)}`);

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
