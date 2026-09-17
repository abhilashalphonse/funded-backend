import crypto from "node:crypto";

export function verifyACGTraderWebhook({ secret, timestamp, signature, body, nowMs = Date.now(), toleranceMs = 300000 }) {
  if (!secret || String(secret).length < 16) throw webhookError("ACG Trader webhook secret is not configured", 503, "ACG_TRADER_WEBHOOK_NOT_CONFIGURED");
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs)) throw webhookError("Invalid webhook timestamp", 401, "ACG_TRADER_WEBHOOK_TIMESTAMP_INVALID");
  if (Math.abs(nowMs - timestampMs) > toleranceMs) throw webhookError("Webhook timestamp is outside the replay window", 401, "ACG_TRADER_WEBHOOK_EXPIRED");
  if (typeof signature !== "string" || !signature.startsWith("sha256=")) throw webhookError("Webhook signature is missing", 401, "ACG_TRADER_WEBHOOK_SIGNATURE_MISSING");

  const expected = signACGTraderWebhook(secret, String(timestamp), body);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw webhookError("Webhook signature is invalid", 401, "ACG_TRADER_WEBHOOK_SIGNATURE_INVALID");
  }
  return true;
}

export function signACGTraderWebhook(secret, timestamp, body) {
  return `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${canonicalJson(body)}`).digest("hex")}`;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function webhookError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
