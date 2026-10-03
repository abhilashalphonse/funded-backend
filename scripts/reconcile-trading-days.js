import "dotenv/config";
import mongoose from "mongoose";
import { connectDatabase } from "../src/config/database.js";
import { auditAndReconcileHistoricalTradingDays } from "../src/maintenance/tradingDayReconciliation.js";

const apply = process.argv.includes("--apply");
const accountId = argValue("--account-id");
const afterAccountId = argValue("--after");
const allowBulk = process.argv.includes("--allow-bulk");
const allowProduction = process.argv.includes("--allow-production");
const limitRaw = argValue("--limit");
const limit = limitRaw == null ? null : Number(limitRaw);

if (limitRaw != null && (!Number.isInteger(limit) || limit <= 0)) {
  fail("INVALID_LIMIT", "--limit must be a positive integer.");
}

const environmentName = resolveEnvironment();
const isProduction = /prod/i.test(environmentName) || String(process.env.NODE_ENV || "").toLowerCase() === "production";

if (apply && !accountId && !allowBulk) {
  fail("BULK_APPLY_REQUIRES_FLAG", "Bulk apply requires --allow-bulk or a specific --account-id.");
}

if (apply && isProduction && !allowProduction) {
  fail("PRODUCTION_APPLY_REQUIRES_FLAG", "Production apply requires --allow-production.");
}

const mode = apply ? "APPLY" : "DRY_RUN";

try {
  console.log(`[ACG_TRADING_DAY_RECONCILIATION] ${mode} SAFETY ${JSON.stringify({
    environment: environmentName,
    accountId: accountId || null,
    afterAccountId: afterAccountId || null,
    limit,
    allowBulk,
    allowProduction,
  })}`);

  await connectDatabase();

  const result = await auditAndReconcileHistoricalTradingDays({
    apply,
    accountId,
    afterAccountId,
    limit,
  });

  console.log(`[ACG_TRADING_DAY_RECONCILIATION] ${mode} SUMMARY ${JSON.stringify({
    nextCursor: result.nextCursor,
    ...result.summary,
  })}`);

  for (const record of result.records) {
    console.log(`[ACG_TRADING_DAY_RECONCILIATION] ${mode} ACCOUNT ${JSON.stringify(record)}`);
  }

  if (apply && (result.summary.manualReviewRequired > 0 || result.summary.verificationFailures > 0)) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error("[ACG_TRADING_DAY_RECONCILIATION] FAILED", {
    code: error?.code,
    message: error?.message,
    details: error?.details,
  });
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}

function resolveEnvironment() {
  return String(
    process.env.RAILWAY_ENVIRONMENT_NAME
    || process.env.RAILWAY_ENVIRONMENT
    || process.env.NODE_ENV
    || "unknown"
  );
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

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}