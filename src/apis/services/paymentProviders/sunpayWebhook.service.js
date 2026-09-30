import crypto from "node:crypto";
import env from "../../../config/env.js";

function webhookSecret() {
  // Migration compatibility: prefer the dedicated merchant webhook secret.
  // Until the staged production variable is accepted, keep the existing
  // pay-in callback behavior available via the pay-in API secret. Payout
  // readiness still requires SUNPAY_WEBHOOK_SECRET explicitly.
  const value = String(env.SUNPAY_WEBHOOK_SECRET || env.SUNPAY_API_SECRET || "").trim();
  if (!value) {
    const error = new Error("SUNPAY_WEBHOOK_SECRET is not configured.");
    error.status = 503;
    error.code = "SUNPAY_WEBHOOK_NOT_CONFIGURED";
    throw error;
  }
  return value;
}

function safeEqualHex(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || "").trim().toLowerCase());
  const right = Buffer.from(String(rightValue || "").trim().toLowerCase());
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function computeSunpayWebhookSignature(rawBody, secret = webhookSecret()) {
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
  return crypto.createHmac("sha256", String(secret)).update(raw).digest("hex");
}

export function verifySunpayWebhookSignature(rawBody, signature, secret = null) {
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
  if (!raw.length || !signature) return false;
  return safeEqualHex(
    computeSunpayWebhookSignature(raw, secret || webhookSecret()),
    signature,
  );
}

export function isSunpayWebhookConfigured() {
  return Boolean(env.SUNPAY_WEBHOOK_SECRET);
}
