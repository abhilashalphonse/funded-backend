import "dotenv/config";
import mongoose from "mongoose";
import { connectDatabase } from "../src/config/database.js";
import Account from "../src/accounts/account.model.js";
import { getTradingConnector } from "../src/connectors/trading/registry.js";
import { buildTradingPermissions } from "../src/connectors/trading/account-provisioning.js";

const apply = process.argv.includes("--apply");
const allowBulk = process.argv.includes("--allow-bulk");
const allowProduction = process.argv.includes("--allow-production");
const accountId = argValue("--account-id");
const limit = Number(argValue("--limit") || 200);

if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) fail("INVALID_LIMIT", "--limit must be between 1 and 1000.");
const environmentName = String(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV || "unknown");
const isProduction = /prod/i.test(environmentName) || String(process.env.NODE_ENV || "").toLowerCase() === "production";
if (apply && !accountId && !allowBulk) fail("BULK_APPLY_REQUIRES_FLAG", "Bulk apply requires --allow-bulk or --account-id.");
if (apply && isProduction && !allowProduction) fail("PRODUCTION_APPLY_REQUIRES_FLAG", "Production apply requires --allow-production.");

const mode = apply ? "APPLY" : "DRY_RUN";

try {
  await connectDatabase();
  const query = {
    platform: "acg-trader",
    platformAccountId: { $nin: [null, ""] },
    ...(accountId ? { accountId } : {}),
  };
  const accounts = await Account.find(query)
    .sort({ accountId: 1 })
    .limit(limit)
    .select("accountId platform platformAccountId commercialTerms status currentPhase")
    .lean();

  const connector = getTradingConnector("acg-trader");
  const records = [];
  for (const account of accounts) {
    const tradingPermissions = buildTradingPermissions(account);
    const record = {
      accountId: account.accountId,
      platformAccountId: account.platformAccountId,
      status: account.status,
      phase: account.currentPhase,
      tradingPermissions,
      synced: false,
    };

    if (apply) {
      await connector.syncChallenge({
        platformAccountId: account.platformAccountId,
        tradingPermissions,
      });
      record.synced = true;
    }
    records.push(record);
    console.log(`[ACG_TRADING_PERMISSIONS] ${mode} ACCOUNT ${JSON.stringify(record)}`);
  }

  console.log(`[ACG_TRADING_PERMISSIONS] ${mode} SUMMARY ${JSON.stringify({
    environment: environmentName,
    matched: accounts.length,
    synced: records.filter(item => item.synced).length,
    permissiveMissingValues: true,
  })}`);
} catch (error) {
  console.error("[ACG_TRADING_PERMISSIONS] FAILED", {
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
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) return process.argv[index + 1];
  return null;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
