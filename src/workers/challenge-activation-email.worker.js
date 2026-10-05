import { recoverPages, periodicRecovery } from "./recovery-sweep.js";
import Payment from "../models/payment.model.js";
import Customer from "../customers/customer.model.js";
import { sendChallengeActivationEmail } from "../email/challengeActivationEmail.service.js";
import { recordAnalyticsEventOnce } from "../apis/services/analytics.service.js";
import { CHALLENGE_ACTIVATION_EMAIL_QUEUE, enqueueChallengeActivationEmail } from "./challenge-activation-email.queue.js";

const STALE_PENDING_MS = 10 * 60 * 1000;

export class ChallengeActivationEmailWorker {
  constructor(boss) {
    if (!boss) throw new Error("ChallengeActivationEmailWorker requires pg-boss.");
    this.boss = boss;
  }

  async start() {
    if (!this.recovery) this.recovery = periodicRecovery(() => this.recoverOutstanding());
    await this.recovery.tick();
    await this.boss.work(CHALLENGE_ACTIVATION_EMAIL_QUEUE, { batchSize: 5, newJobCheckInterval: 500 }, async jobOrJobs => {
      const jobs = Array.isArray(jobOrJobs) ? jobOrJobs : [jobOrJobs];
      for (const job of jobs) await this.handle(job);
    });
    console.log("ChallengeActivationEmailWorker listening on challenge-activation-email");
  }

  async stop() { await this.recovery?.stop(); this.recovery = null; }

  async recoverOutstanding() {
    const staleBefore = new Date(Date.now() - STALE_PENDING_MS);
    return recoverPages({ model: Payment, filter: {
      status: "PAID",
      accountId: { $type: "string" },
      "activation.status": "ACTIVE",
      $or: [
        { "activationEmail.status": { $exists: false } },
        { "activationEmail.status": { $in: ["NOT_SENT", "FAILED"] } },
        { "activationEmail.status": "PENDING", "activationEmail.attemptedAt": { $lt: staleBefore } },
      ],
    },
      enqueue: id => enqueueChallengeActivationEmail(this.boss, id, { singletonKey: String(id) }),
      onError: (error, id) => console.error("Recovery enqueue failed", String(id), error.message),
    });
  }

  async handle(job) {
    const paymentId = String(job?.data?.paymentId || "").trim();
    if (!paymentId) throw new Error("challenge activation email job is missing paymentId.");

    const staleBefore = new Date(Date.now() - STALE_PENDING_MS);
    const payment = await Payment.findOneAndUpdate(
      {
        _id: paymentId,
        status: "PAID",
        accountId: { $type: "string" },
        "activation.status": "ACTIVE",
        $or: [
          { "activationEmail.status": { $exists: false } },
          { "activationEmail.status": { $in: ["NOT_SENT", "FAILED"] } },
          { "activationEmail.status": "PENDING", "activationEmail.attemptedAt": { $lt: staleBefore } },
        ],
      },
      {
        $set: {
          "activationEmail.status": "PENDING",
          "activationEmail.attemptedAt": new Date(),
          "activationEmail.error": null,
        },
        $inc: { "activationEmail.attempts": 1 },
      },
      { new: true },
    );

    if (!payment) return;

    try {
      const customer = payment.customerId
        ? await Customer.findOne({ customerId: payment.customerId }).select("supabaseUserId primaryEmail").lean()
        : null;
      const registered = Boolean(customer?.supabaseUserId);

      await sendChallengeActivationEmail({
        to: payment.email,
        payment,
        registered,
      });

      const sentAt = new Date();
      await Payment.updateOne(
        { _id: payment._id, "activationEmail.status": "PENDING" },
        {
          $set: {
            "activationEmail.status": "SENT",
            "activationEmail.sentAt": sentAt,
            "activationEmail.error": null,
          },
        },
      );

      await recordAnalyticsEventOnce({
        event: "activation_email_sent",
        sessionId: payment.metadata?.analyticsSessionId || `payment:${payment._id}`,
        email: payment.email,
        paymentId: String(payment._id),
        accountId: payment.accountId,
        source: "server",
        attribution: payment.metadata?.attribution || {},
        properties: { registered },
      }, { paymentId: String(payment._id), accountId: payment.accountId }).catch(() => {});
    } catch (error) {
      await Payment.updateOne(
        { _id: payment._id },
        {
          $set: {
            "activationEmail.status": "FAILED",
            "activationEmail.error": String(error?.message || "Activation email failed").slice(0, 1000),
          },
        },
      );
      throw error;
    }
  }
}
