export const TRADING_CREDENTIAL_EMAIL_QUEUE = "trading-credential-email";

export async function enqueueTradingCredentialEmail(boss, credentialSecretId, options = {}) {
  if (!boss) throw new Error("pg-boss instance is required for trading credential email.");
  const id = String(credentialSecretId || "").trim();
  if (!id) throw new Error("credentialSecretId is required.");

  return boss.send(
    TRADING_CREDENTIAL_EMAIL_QUEUE,
    { credentialSecretId: id, force: Boolean(options.force), queuedAt: new Date().toISOString() },
    {
      retryLimit: options.retryLimit ?? 10,
      retryBackoff: true,
      retryDelay: options.retryDelay ?? 10,
      expireInMinutes: options.expireInMinutes ?? 10,
    },
  );
}
