import crypto from "node:crypto";

const DEFAULT_QUOTE_TTL_MS = 10 * 60 * 1000;

function quoteSecret() {
  const secret = String(process.env.PAYOUT_QUOTE_SECRET || "").trim();
  if (secret.length < 32) {
    const error = new Error("PAYOUT_QUOTE_SECRET must be configured with at least 32 characters.");
    error.status = 503;
    error.code = "PAYOUT_QUOTE_SECRET_NOT_CONFIGURED";
    throw error;
  }
  return secret;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(value) {
  try {
    return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
  } catch {
    const error = new Error("Invalid payout quote.");
    error.status = 400;
    error.code = "INVALID_PAYOUT_QUOTE";
    throw error;
  }
}

function sign(encoded, secret = quoteSecret()) {
  return crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function issuePayoutQuoteToken(
  payload,
  {
    now = () => new Date(),
    ttlMs = DEFAULT_QUOTE_TTL_MS,
    secret = null,
  } = {},
) {
  const issuedAt = now();
  const expiresAt = new Date(issuedAt.getTime() + Math.max(60_000, Number(ttlMs) || DEFAULT_QUOTE_TTL_MS));
  const body = {
    v: 1,
    ...payload,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  const encoded = encode(body);
  const signature = sign(encoded, secret || quoteSecret());
  return {
    quoteId: `${encoded}.${signature}`,
    quoteExpiresAt: expiresAt,
    payload: body,
  };
}

export function verifyPayoutQuoteToken(
  token,
  {
    now = () => new Date(),
    secret = null,
  } = {},
) {
  const [encoded, signature, ...extra] = String(token || "").split(".");
  if (!encoded || !signature || extra.length) {
    const error = new Error("A valid payout quote is required.");
    error.status = 400;
    error.code = "PAYOUT_QUOTE_REQUIRED";
    throw error;
  }

  const expected = sign(encoded, secret || quoteSecret());
  if (!safeEqual(signature, expected)) {
    const error = new Error("Payout quote signature is invalid.");
    error.status = 400;
    error.code = "INVALID_PAYOUT_QUOTE";
    throw error;
  }

  const payload = decode(encoded);
  if (payload?.v !== 1) {
    const error = new Error("Unsupported payout quote version.");
    error.status = 400;
    error.code = "INVALID_PAYOUT_QUOTE";
    throw error;
  }

  const expiresAt = new Date(payload.expiresAt || 0);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now()) {
    const error = new Error("This payout quote has expired. Request a new quote.");
    error.status = 409;
    error.code = "PAYOUT_QUOTE_EXPIRED";
    throw error;
  }

  return payload;
}

export function payoutQuoteConfigured() {
  try {
    quoteSecret();
    return true;
  } catch {
    return false;
  }
}
