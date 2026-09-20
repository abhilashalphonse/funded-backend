import "../src/config/env.js";
import mongoose from "mongoose";
import Account from "../src/accounts/account.model.js";
import boss from "../src/config/boss.js";
import { ensureTradingCredential, tradingCredentialsConfigured } from "../src/trading-credentials/trading-credential.service.js";

async function main() {
  if (!tradingCredentialsConfigured()) {
    throw new Error("TRADING_CREDENTIAL_ENCRYPTION_KEY is not configured.");
  }
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required.");

  await mongoose.connect(process.env.MONGODB_URI);
  await boss.start();

  const accounts = await Account.find({
    platform: "acg-trader",
    enabled: true,
    status: { $in: ["ACTIVE", "PHASE_2", "FUNDED"] },
    $or: [
      { platformAccountId: { $type: "string" } },
      { "platformAccounts.0": { $exists: true } },
    ],
  }).sort({ createdAt: 1 });

  let created = 0;
  let existing = 0;
  let skipped = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      const result = await ensureTradingCredential(account, { queueEmail: true });
      if (result?.skipped) skipped += 1;
      else if (result?.created || result?.rotated) created += 1;
      else existing += 1;
      console.log(account.accountId, result);
    } catch (error) {
      failed += 1;
      console.error(account.accountId, error?.message || error);
    }
  }

  console.log(JSON.stringify({ total: accounts.length, created, existing, skipped, failed }, null, 2));
  await boss.stop();
  await mongoose.disconnect();
  if (failed) process.exitCode = 1;
}

main().catch(async error => {
  console.error(error);
  await boss.stop().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
