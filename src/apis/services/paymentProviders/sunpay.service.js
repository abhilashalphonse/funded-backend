import crypto from "node:crypto";
import env from "../../../config/env.js";
import { verifySunpayWebhookSignature } from "./sunpayWebhook.service.js";

export const SUNPAY_PAYIN_MIN_INR = 100;
export const SUNPAY_PAYIN_MAX_INR = 50000;

function baseUrl() {
  return String(env.SUNPAY_BASE_URL || "https://ttpay.business").trim().replace(/\/$/, "");
}

function apiKey() {
  const value = String(env.SUNPAY_API_KEY || "").trim();
  if (!value) {
    const error = new Error("SUNPAY_API_KEY is not configured.");
    error.status = 503;
    error.code = "SUNPAY_NOT_CONFIGURED";
    throw error;
  }
  return value;
}

function apiSecret() {
  const value = String(env.SUNPAY_API_SECRET || "").trim();
  if (!value) {
    const error = new Error("SUNPAY_API_SECRET is not configured.");
    error.status = 503;
    error.code = "SUNPAY_NOT_CONFIGURED";
    throw error;
  }
  return value;
}

export function computeSunpaySignature(rawBody, secret) {
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
  return crypto.createHmac("sha256", String(secret || "")).update(raw).digest("hex");
}

function signBody(body) {
  return computeSunpaySignature(body, apiSecret());
}

export function verifySunpayWebhook(rawBody, signature, secret = null) {
  return verifySunpayWebhookSignature(rawBody, signature, secret);
}

export async function createSunpayOrder({
  amountInr,
  orderId,
  redirectUrl,
  customerMobile,
  customerEmail,
  customerName,
  paymentId,
}) {
  const normalizedAmount = Number(amountInr);
  if (!Number.isInteger(normalizedAmount)) {
    const error = new Error("Sunpay UPI pay-in amount must be a whole INR value.");
    error.status = 400;
    error.code = "SUNPAY_WHOLE_INR_REQUIRED";
    throw error;
  }
  if (normalizedAmount < SUNPAY_PAYIN_MIN_INR || normalizedAmount > SUNPAY_PAYIN_MAX_INR) {
    const error = new Error(
      `Sunpay UPI pay-in amount must be between ₹${SUNPAY_PAYIN_MIN_INR} and ₹${SUNPAY_PAYIN_MAX_INR}.`,
    );
    error.status = 400;
    error.code = "SUNPAY_AMOUNT_OUT_OF_RANGE";
    throw error;
  }

  const payload = {
    order_id: String(orderId),
    amount: normalizedAmount,
    currency: "INR",
    method: "upi",
    notify_url: String(redirectUrl),
    metadata: {
      internal_ref: String(paymentId || orderId),
    },
  };

  if (customerName) payload.customer_name = String(customerName);
  if (customerMobile) payload.customer_phone = String(customerMobile);
  if (customerEmail) payload.customer_email = String(customerEmail);

  const body = JSON.stringify(payload);
  const response = await fetch(`${baseUrl()}/api/public/v1/payins`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey(),
      "x-signature": signBody(body),
      accept: "application/json",
    },
    body,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `Sunpay create-order failed (${response.status}).`);
    error.status = response.status >= 400 ? response.status : 502;
    error.code = "SUNPAY_CREATE_ORDER_FAILED";
    throw error;
  }

  const checkoutUrl = data?.checkout_url || data?.payment_url || data?.redirect_url || null;
  if (!checkoutUrl) {
    const error = new Error("Sunpay create-order did not return a checkout URL.");
    error.status = 502;
    error.code = "SUNPAY_CHECKOUT_URL_MISSING";
    throw error;
  }

  return { data, checkoutUrl };
}

export function normalizeSunpayStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (status === "pending") return "WAITING";
  if (status === "processing") return "CONFIRMING";
  if (status === "success") return "PAID";
  if (status === "failed") return "FAILED";
  if (status === "expired") return "EXPIRED";
  return "WAITING";
}
