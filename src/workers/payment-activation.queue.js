export const PAYMENT_ACTIVATION_QUEUE = "payment-activation";

export async function enqueuePaymentActivation(boss, paymentId, options = {}) {
  if (!boss) throw new Error("pg-boss instance is required for payment activation.");
  const id = String(paymentId || "").trim();
  if (!id) throw new Error("paymentId is required for payment activation.");
  return boss.send(
    PAYMENT_ACTIVATION_QUEUE,
    { paymentId: id, queuedAt: new Date().toISOString() },
    {
      retryLimit: options.retryLimit ?? 12,
      retryBackoff: true,
      retryDelay: options.retryDelay ?? 5,
      expireInMinutes: options.expireInMinutes ?? 15,
    },
  );
}
