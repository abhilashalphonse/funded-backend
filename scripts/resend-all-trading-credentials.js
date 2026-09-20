import "../src/config/env.js";
import mongoose from "mongoose";
import Account from "../src/accounts/account.model.js";
import Customer from "../src/customers/customer.model.js";
import TradingCredentialSecret from "../src/trading-credentials/trading-credential-secret.model.js";
import boss from "../src/config/boss.js";
import { ensureTradingCredential } from "../src/trading-credentials/trading-credential.service.js";
import { enqueueTradingCredentialEmail } from "../src/workers/trading-credential-email.queue.js";

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required.");
  if (!process.env.TRADING_CREDENTIAL_ENCRYPTION_KEY) throw new Error("TRADING_CREDENTIAL_ENCRYPTION_KEY is required.");
  if (!process.env.RESEND_API_KEY || !process.env.TRADING_EMAIL_FROM) throw new Error("Resend email configuration is required.");

  await mongoose.connect(process.env.MONGODB_URI);
  await boss.start();
  await boss.createQueue("trading-credential-email");

  const accounts = await Account.find({
    platform: "acg-trader",
    enabled: true,
    status: { $in: ["ACTIVE", "PHASE_2", "FUNDED"] },
  }).sort({ createdAt: 1 });

  let queued = 0;
  let skipped = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      let email = null;
      if (account.customerId) {
        const customer = await Customer.findOne({ customerId: account.customerId }).select("primaryEmail").lean();
        email = customer?.primaryEmail || null;
      }

      const result = await ensureTradingCredential(account, {
        email,
        queueEmail: false,
        platformAccountId: account.platformAccountId,
      });

      if (result?.skipped || !result?.credentialSecretId) {
        skipped += 1;
        console.log(account.accountId, "SKIPPED", result?.reason || "credential unavailable");
        continue;
      }

      const credential = await TradingCredentialSecret.findById(result.credentialSecretId);
      if (!credential) {
        skipped += 1;
        console.log(account.accountId, "SKIPPED credential record missing");
        continue;
      }

      if (!credential.deliveryEmail && email) credential.deliveryEmail = String(email).trim().toLowerCase();
      if (!credential.deliveryEmail) {
        skipped += 1;
        console.log(account.accountId, "SKIPPED no delivery email");
        continue;
      }

      credential.delivery.status = "PENDING";
      credential.delivery.error = null;
      await credential.save();

      await enqueueTradingCredentialEmail(boss, credential._id, { force: true });
      queued += 1;
      console.log(account.accountId, "QUEUED", credential.deliveryEmail);
    } catch (error) {
      failed += 1;
      console.error(account.accountId, "FAILED", error?.message || error);
    }
  }

  console.log(JSON.stringify({ total: accounts.length, queued, skipped, failed }, null, 2));
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
