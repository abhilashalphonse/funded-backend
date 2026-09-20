import TradingCredentialSecret from "../trading-credentials/trading-credential-secret.model.js";
import Account from "../accounts/account.model.js";
import { revealStoredPassword } from "../trading-credentials/trading-credential.service.js";
import { sendTradingCredentialsEmail } from "../email/email.service.js";
import { TRADING_CREDENTIAL_EMAIL_QUEUE } from "./trading-credential-email.queue.js";

export class TradingCredentialEmailWorker {
  constructor(boss) {
    if (!boss) throw new Error("TradingCredentialEmailWorker requires pg-boss.");
    this.boss = boss;
  }

  async start() {
    await this.boss.work(TRADING_CREDENTIAL_EMAIL_QUEUE, { batchSize: 5, newJobCheckInterval: 500 }, async jobOrJobs => {
      const jobs = Array.isArray(jobOrJobs) ? jobOrJobs : [jobOrJobs];
      for (const job of jobs) await this.handle(job);
    });
    console.log("TradingCredentialEmailWorker listening on trading-credential-email");
  }

  async handle(job) {
    const id = String(job?.data?.credentialSecretId || "").trim();
    if (!id) throw new Error("trading credential email job is missing credentialSecretId.");

    const credential = await TradingCredentialSecret.findById(id);
    if (!credential || credential.delivery?.status === "SENT") return;
    if (!credential.deliveryEmail) {
      credential.delivery.status = "FAILED";
      credential.delivery.error = "No delivery email is available.";
      await credential.save();
      return;
    }

    const account = await Account.findOne({ accountId: credential.accountId }).lean();
    if (!account) {
      credential.delivery.status = "FAILED";
      credential.delivery.error = "Trading account no longer exists.";
      await credential.save();
      return;
    }

    credential.delivery.status = "PENDING";
    credential.delivery.attempts = Number(credential.delivery?.attempts || 0) + 1;
    credential.delivery.lastAttemptAt = new Date();
    credential.delivery.error = null;
    await credential.save();

    try {
      await sendTradingCredentialsEmail({
        to: credential.deliveryEmail,
        login: credential.login,
        password: revealStoredPassword(credential),
        accountId: account.accountId,
        accountSize: account.accountSize,
        accountMode: account.accountMode,
        challengeType: account.challengeType,
        leverage: account.leverage || 100,
        tenantId: process.env.ACG_TRADER_TENANT || "acg-funded",
      });
      credential.delivery.status = "SENT";
      credential.delivery.sentAt = new Date();
      credential.delivery.error = null;
      await credential.save();
    } catch (error) {
      credential.delivery.status = "FAILED";
      credential.delivery.error = String(error?.message || "Email send failed").slice(0, 1000);
      await credential.save();
      throw error;
    }
  }
}
