import { createHmac, timingSafeEqual } from "node:crypto";

const RESEND_API = "https://api.resend.com";
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function resendApiKey() {
  return String(process.env.RESEND_API_KEY || "").trim();
}

function supportFrom() {
  return String(
    process.env.SUPPORT_EMAIL_FROM
      || process.env.TRADING_EMAIL_FROM
      || "ACG Funded Support <support@acgfunded.com>",
  ).trim();
}

function base64Secret(secret) {
  const value = String(secret || "").trim();
  if (!value) return null;
  const encoded = value.startsWith("whsec_") ? value.slice(6) : value;
  try {
    return Buffer.from(encoded, "base64");
  } catch {
    return null;
  }
}

function safeEqualBase64(actual, expected) {
  try {
    const left = Buffer.from(String(actual || ""), "base64");
    const right = Buffer.from(String(expected || ""), "base64");
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export function verifyResendWebhook(rawBody, headers) {
  const secret = base64Secret(process.env.RESEND_WEBHOOK_SECRET);
  if (!secret) {
    const error = new Error("Resend webhook verification is not configured.");
    error.status = 503;
    error.code = "RESEND_WEBHOOK_NOT_CONFIGURED";
    throw error;
  }

  const id = String(headers["svix-id"] || "").trim();
  const timestamp = String(headers["svix-timestamp"] || "").trim();
  const signatureHeader = String(headers["svix-signature"] || "").trim();

  if (!id || !timestamp || !signatureHeader) {
    const error = new Error("Missing Resend webhook signature headers.");
    error.status = 400;
    error.code = "INVALID_WEBHOOK_SIGNATURE";
    throw error;
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    const error = new Error("Invalid Resend webhook timestamp.");
    error.status = 400;
    error.code = "INVALID_WEBHOOK_SIGNATURE";
    throw error;
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds);
  if (ageSeconds > WEBHOOK_TOLERANCE_SECONDS) {
    const error = new Error("Expired Resend webhook signature.");
    error.status = 400;
    error.code = "INVALID_WEBHOOK_SIGNATURE";
    throw error;
  }

  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
  const signed = `${id}.${timestamp}.${payload}`;
  const expected = createHmac("sha256", secret).update(signed).digest("base64");

  const signatures = signatureHeader
    .split(/\s+/)
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => {
      const comma = value.indexOf(",");
      return comma >= 0 ? value.slice(comma + 1) : value;
    });

  if (!signatures.some(signature => safeEqualBase64(signature, expected))) {
    const error = new Error("Invalid Resend webhook signature.");
    error.status = 400;
    error.code = "INVALID_WEBHOOK_SIGNATURE";
    throw error;
  }

  try {
    return JSON.parse(payload);
  } catch {
    const error = new Error("Invalid Resend webhook JSON.");
    error.status = 400;
    error.code = "INVALID_WEBHOOK_PAYLOAD";
    throw error;
  }
}

async function resendRequest(path, options = {}) {
  const apiKey = resendApiKey();
  if (!apiKey) {
    const error = new Error("Resend API is not configured.");
    error.status = 503;
    error.code = "RESEND_NOT_CONFIGURED";
    throw error;
  }

  const response = await fetch(`${RESEND_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.message || `Resend request failed (${response.status}).`);
    error.status = response.status >= 500 ? 502 : response.status;
    error.code = "RESEND_REQUEST_FAILED";
    error.providerStatus = response.status;
    throw error;
  }
  return payload;
}

export async function retrieveReceivedEmail(emailId) {
  const id = encodeURIComponent(String(emailId || "").trim());
  if (!id) throw new Error("Received email ID is required.");
  return resendRequest(`/emails/${id}`);
}

export async function sendSupportEmail({
  to,
  subject,
  text,
  html,
  inReplyTo,
  references,
  replyTo,
  idempotencyKey,
}) {
  const recipient = String(to || "").trim().toLowerCase();
  if (!recipient) throw new Error("Support email recipient is required.");

  const headers = {};
  if (inReplyTo) headers["In-Reply-To"] = String(inReplyTo);
  if (references) headers.References = String(references);

  return resendRequest("/emails", {
    method: "POST",
    headers: idempotencyKey ? { "Idempotency-Key": String(idempotencyKey) } : {},
    body: JSON.stringify({
      from: supportFrom(),
      to: [recipient],
      subject: String(subject || "ACG Funded Support"),
      ...(text ? { text: String(text) } : {}),
      ...(html ? { html: String(html) } : {}),
      ...(replyTo ? { reply_to: String(replyTo) } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    }),
  });
}

export function extractEmailAddress(value) {
  const text = String(value || "").trim();
  const bracketed = text.match(/<([^<>\s]+@[^<>\s]+)>/);
  const candidate = (bracketed?.[1] || text).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : "";
}

export function normalizeEmailSubject(value) {
  return String(value || "")
    .replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "")
    .trim()
    .slice(0, 240)
    .toLowerCase();
}

export function replySubject(value) {
  const subject = String(value || "").trim() || "ACG Funded Support";
  return /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

export function supportEmailConfigured() {
  return Boolean(
    resendApiKey()
    && String(process.env.RESEND_WEBHOOK_SECRET || "").trim()
    && String(process.env.SUPPORT_EMAIL_FROM || process.env.TRADING_EMAIL_FROM || "").trim(),
  );
}
