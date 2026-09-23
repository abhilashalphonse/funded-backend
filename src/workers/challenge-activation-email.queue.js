export const CHALLENGE_ACTIVATION_EMAIL_QUEUE = "challenge-activation-email";

export async function enqueueChallengeActivationEmail(boss, paymentId, options = {}) {
  if (!boss) throw new Error("pg-boss instance is required for challenge activation email.");
  const id = String(paymentId || "").trim();
  if (!id) throw new Error("paymentId is required.");

  return boss.send(
    CHALLENGE_ACTIVATION_EMAIL_QUEUE,
    { paymentId: id, queuedAt: new Date().toISOString() },
    {
      retryLimit: options.retryLimit ?? 10,
      retryBackoff: true,
      retryDelay: options.retryDelay ?? 10,
      expireInMinutes: options.expireInMinutes ?? 10,
    },
  );
}
