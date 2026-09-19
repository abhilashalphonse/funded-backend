import Payment from "../models/payment.model.js";
import { activatePaidPayment } from "../apis/services/payment.service.js";
import { recordAnalyticsEventOnce } from "../apis/services/analytics.service.js";
import { PAYMENT_ACTIVATION_QUEUE, enqueuePaymentActivation } from "./payment-activation.queue.js";

export class PaymentActivationWorker {
  constructor(boss) {
    if (!boss) throw new Error("PaymentActivationWorker requires pg-boss.");
    this.boss = boss;
  }

  async start() {
    await this.recoverOutstanding();
    await this.boss.work(PAYMENT_ACTIVATION_QUEUE, { batchSize: 5, newJobCheckInterval: 250 }, async jobOrJobs => {
      const jobs = Array.isArray(jobOrJobs) ? jobOrJobs : [jobOrJobs];
      for (const job of jobs) await this.handle(job);
    });
    console.log("PaymentActivationWorker listening on payment-activation");
  }

  async recoverOutstanding() {
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
    const outstanding = await Payment.find({
      status: "PAID",
      accountId: { $exists: false },
      $or: [
        { "activation.status": { $exists: false } },
        { "activation.status": { $in: ["NOT_STARTED", "FAILED"] } },
        { "activation.status": "PENDING", "activation.attemptedAt": { $lt: staleBefore } },
      ],
    }).select("_id").limit(500).lean();

    for (const payment of outstanding) {
      await enqueuePaymentActivation(this.boss, payment._id).catch(error => {
        console.error("[PAYMENT ACTIVATION] Failed to recover payment:", payment._id, error?.message || error);
      });
    }
  }

  async handle(job) {
    const paymentId = String(job?.data?.paymentId || "").trim();
    if (!paymentId) throw new Error("payment-activation job is missing paymentId.");

    const payment = await Payment.findById(paymentId);
    if (!payment || payment.status !== "PAID") return;
    if (payment.accountId && payment.activation?.status === "ACTIVE") return;

    const accountId = await activatePaidPayment(payment);
    if (!accountId) {
      const current = await Payment.findById(paymentId).select("accountId activation").lean();
      if (current?.accountId) return;
      const error = new Error("Payment activation is currently claimed by another worker.");
      error.code = "PAYMENT_ACTIVATION_BUSY";
      throw error;
    }

    await recordAnalyticsEventOnce({
      event: "challenge_activated",
      sessionId: payment.metadata?.analyticsSessionId || `payment:${payment._id}`,
      email: payment.email,
      paymentId: String(payment._id),
      accountId,
      source: "server",
      attribution: payment.metadata?.attribution || {},
      properties: {
        amount: payment.amount,
        currency: payment.currency,
        accountSize: payment.challengeDefinition?.accountSize,
        step: payment.challengeDefinition?.step,
        profitSplit: payment.commercialConfig?.profitSplit,
      },
    }, { paymentId: String(payment._id), accountId }).catch(() => {});
  }
}
