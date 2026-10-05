import "dotenv/config";
import mongoose from "mongoose";
import Account from "../src/accounts/account.model.js";
import { permissionMigrationPayload } from "../src/accounts/permission-migration.js";
import { getTradingConnector } from "../src/connectors/trading/registry.js";
import { compareTradingPermissions } from "../src/accounts/permission-reconciliation.js";

const limit = Number(argValue("--limit") || 500);
if (!Number.isInteger(limit) || limit <= 0 || limit > 5000) fail("INVALID_LIMIT", "--limit must be between 1 and 5000.");

const accountId = argValue("--account-id");
const connector = getTradingConnector("acg-trader");

try {
  const mongoUri = String(process.env.MONGODB_URI || "").trim();
  if (!mongoUri) fail("MONGODB_URI_REQUIRED", "MONGODB_URI is required.");
  await mongoose.connect(mongoUri);

  const query = {
    platform: "acg-trader",
    platformAccountId: { $nin: [null, ""] },
    ...(accountId ? { accountId } : {}),
  };

  const accounts = await Account.find(query)
    .sort({ accountId: 1 })
    .limit(limit)
    .select("accountId accountMode platform platformAccountId commercialTerms tradingPermissionsVersion createdAt")
    .lean();

  let matched = 0;
  let mismatched = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      const expected = permissionMigrationPayload(account);
      const remote = await connector.getAccount({ platformAccountId: account.platformAccountId });
      const actualPermissions = remote?.raw?.tradingPermissions || {};
      const actualVersion = Number(remote?.raw?.tradingPermissionsVersion ?? 0);
      const expectedVersion = Number(expected.tradingPermissionsVersion);

      const diff = compareTradingPermissions(expected.tradingPermissions, expectedVersion, actualPermissions, actualVersion);
      if (diff.length) {
        mismatched += 1;
        console.log("[ACG_TRADING_PERMISSIONS] RECONCILE ACCOUNT", JSON.stringify({
          accountId: account.accountId,
          platformAccountId: account.platformAccountId,
          state: "MISMATCH",
          diff,
          expected: {
            newsTrading: expected.tradingPermissions.newsTrading,
            weekendHolding: expected.tradingPermissions.weekendHolding,
            version: expectedVersion,
          },
          actual: {
            newsTrading: actualPermissions.newsTrading,
            weekendHolding: actualPermissions.weekendHolding,
            version: actualVersion,
          },
        }));
      } else {
        matched += 1;
        console.log("[ACG_TRADING_PERMISSIONS] RECONCILE ACCOUNT", JSON.stringify({
          accountId: account.accountId,
          platformAccountId: account.platformAccountId,
          state: "MATCHED",
        }));
      }
    } catch (error) {
      failed += 1;
      console.error("[ACG_TRADING_PERMISSIONS] RECONCILE ACCOUNT", JSON.stringify({
        accountId: account.accountId,
        platformAccountId: account.platformAccountId,
        state: "FAILED",
        code: error?.code || null,
        message: error?.message || String(error),
      }));
    }
  }

  const summary = {
    total: accounts.length,
    matched,
    mismatched,
    failed,
    complete: mismatched === 0 && failed === 0,
  };
  console.log("[ACG_TRADING_PERMISSIONS] RECONCILE SUMMARY", JSON.stringify(summary));
  if (!summary.complete) process.exitCode = 2;
} catch (error) {
  console.error("[ACG_TRADING_PERMISSIONS] RECONCILE FAILED", {
    code: error?.code,
    message: error?.message,
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
