import crypto from "node:crypto";
import env from "../../../config/env.js";
import { verifySunpayWebhookSignature } from "../paymentProviders/sunpayWebhook.service.js";

function baseUrl() {
  return String(env.SUNPAY_BASE_URL || "https://ttpay.business").trim().replace(/\/$/, "");
}

function payoutApiKey() {
  const value = String(env.SUNPAY_PAYOUT_API_KEY || "").trim();
  if (!value) {
    const error = new Error("SUNPAY_PAYOUT_API_KEY is not configured.");
    error.status = 503;
    error.code = "SUNPAY_PAYOUT_NOT_CONFIGURED";
    throw error;
  }
  return value;
}

function payoutApiSecret() {
  const value = String(env.SUNPAY_PAYOUT_API_SECRET || "").trim();
  if (!value) {
    const error = new Error("SUNPAY_PAYOUT_API_SECRET is not configured.");
    error.status = 503;
    error.code = "SUNPAY_PAYOUT_NOT_CONFIGURED";
    throw error;
  }
  return value;
}

function callbackUrl() {
  const value = String(env.SUNPAY_PAYOUT_CALLBACK_URL || "").trim();
  if (!value) {
    const error = new Error("SUNPAY_PAYOUT_CALLBACK_URL is not configured.");
    error.status = 503;
    error.code = "SUNPAY_PAYOUT_NOT_CONFIGURED";
    throw error;
  }
  return value;
}

function providerError(data, response, fallback) {
  const error = new Error(data?.message || data?.error || fallback);
  error.status = response?.status >= 400 ? response.status : 502;
  error.code = String(data?.error || data?.code || "SUNPAY_PAYOUT_REQUEST_FAILED").trim().toUpperCase();
  error.provider = "sunpay";
  error.providerPayload = {
    minimum: data?.minimum ?? data?.min ?? null,
    maximum: data?.maximum ?? data?.max ?? null,
  };
  return error;
}

export function computeSunpayPayoutSignature(rawBody, secret = payoutApiSecret()) {
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
  return crypto.createHmac("sha256", String(secret)).update(raw).digest("hex");
}

export function verifySunpayPayoutWebhook(rawBody, signature, secret = null) {
  return verifySunpayWebhookSignature(rawBody, signature, secret);
}

export function normalizeSunpayPayoutStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (status === "pending" || status === "processing") return "PROCESSING";
  if (status === "success") return "PAID";
  if (status === "failed" || status === "expired") return "FAILED";
  return "PROCESSING";
}

export function isSunpayPayoutConfigured() {
  return Boolean(
    env.SUNPAY_BASE_URL
    && env.SUNPAY_PAYOUT_API_KEY
    && env.SUNPAY_PAYOUT_API_SECRET
    && env.SUNPAY_PAYOUT_CALLBACK_URL
    && env.SUNPAY_WEBHOOK_SECRET
  );
}

export async function createSunpayPayout({
  payoutId,
  amountInr,
  method,
  beneficiaryName,
  beneficiaryAccount,
  ifsc,
  bankName,
  beneficiaryPhone,
  notifyUrl,
}, {
  fetchImpl = fetch,
  baseUrlValue = baseUrl(),
  apiKeyValue = payoutApiKey(),
  apiSecretValue = payoutApiSecret(),
  callbackUrlValue = callbackUrl(),
} = {}) {
  const normalizedMethod = String(method || "").trim().toLowerCase();
  if (!["upi", "bank"].includes(normalizedMethod)) {
    const error = new Error("Sunpay automated payouts currently support UPI and bank only.");
    error.status = 400;
    error.code = "SUNPAY_PAYOUT_METHOD_UNSUPPORTED";
    throw error;
  }

  const amount = Number(amountInr);
  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error("Sunpay payout amount must be greater than zero.");
    error.status = 400;
    error.code = "SUNPAY_PAYOUT_AMOUNT_INVALID";
    throw error;
  }

  const payload = {
    payout_id: String(payoutId),
    amount: Math.round((amount + Number.EPSILON) * 100) / 100,
    currency: "INR",
    method: normalizedMethod,
    beneficiary_name: String(beneficiaryName || "").trim(),
    beneficiary_account: String(beneficiaryAccount || "").trim(),
    notify_url: String(notifyUrl || callbackUrlValue),
  };

  if (!payload.beneficiary_name || !payload.beneficiary_account) {
    const error = new Error("Sunpay payout beneficiary details are incomplete.");
    error.status = 400;
    error.code = "SUNPAY_PAYOUT_BENEFICIARY_REQUIRED";
    throw error;
  }

  if (normalizedMethod === "bank") {
    const normalizedIfsc = String(ifsc || "").trim().toUpperCase();
    if (!normalizedIfsc) {
      const error = new Error("IFSC is required for Sunpay bank payouts.");
      error.status = 400;
      error.code = "SUNPAY_PAYOUT_IFSC_REQUIRED";
      throw error;
    }
    payload.ifsc = normalizedIfsc;
    if (bankName) payload.bank_name = String(bankName).trim();
  }

  if (normalizedMethod === "upi" && beneficiaryPhone) {
    payload.beneficiary_phone = String(beneficiaryPhone).trim();
  }

  const body = JSON.stringify(payload);
  const response = await fetchImpl(`${String(baseUrlValue).replace(/\/$/, "")}/api/public/v1/payouts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKeyValue,
      "x-signature": computeSunpayPayoutSignature(body, apiSecretValue),
      accept: "application/json",
    },
    body,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw providerError(data, response, `Sunpay create-payout failed (${response.status}).`);
  }

  if (!data?.payout_id || String(data.payout_id) !== String(payoutId)) {
    const error = new Error("Sunpay payout response did not match the requested payout ID.");
    error.status = 502;
    error.code = "SUNPAY_PAYOUT_ID_MISMATCH";
    throw error;
  }

  return {
    provider: "sunpay",
    providerReference: data?.id || null,
    payoutId: data.payout_id,
    status: normalizeSunpayPayoutStatus(data?.status),
    providerStatus: String(data?.status || "").toLowerCase() || null,
    amount: data?.amount == null ? payload.amount : Number(data.amount),
    fee: data?.fee == null ? null : Number(data.fee),
    netAmount: data?.net_amount == null ? null : Number(data.net_amount),
    currency: String(data?.currency || "INR").toUpperCase(),
    method: String(data?.method || normalizedMethod).toUpperCase(),
    createdAt: data?.created_at || null,
    raw: data,
  };
}

export async function getSunpayPayoutStatus(payoutId, {
  fetchImpl = fetch,
  baseUrlValue = baseUrl(),
  apiKeyValue = payoutApiKey(),
} = {}) {
  const id = encodeURIComponent(String(payoutId || "").trim());
  if (!id) {
    const error = new Error("Sunpay payout ID is required.");
    error.status = 400;
    error.code = "SUNPAY_PAYOUT_ID_REQUIRED";
    throw error;
  }

  const response = await fetchImpl(`${String(baseUrlValue).replace(/\/$/, "")}/api/public/v1/payouts/status/${id}`, {
    method: "GET",
    headers: {
      "x-api-key": apiKeyValue,
      accept: "application/json",
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw providerError(data, response, `Sunpay payout-status failed (${response.status}).`);
  }

  return {
    provider: "sunpay",
    providerReference: data?.id || null,
    payoutId: data?.payout_id || String(payoutId),
    status: normalizeSunpayPayoutStatus(data?.status),
    providerStatus: String(data?.status || "").toLowerCase() || null,
    amount: data?.amount == null ? null : Number(data.amount),
    fee: data?.fee == null ? null : Number(data.fee),
    netAmount: data?.net_amount == null ? null : Number(data.net_amount),
    utr: data?.utr || null,
    settledAt: data?.settled_at || null,
    raw: data,
  };
}

export async function getSunpayPayoutBalance(currency = "INR", {
  fetchImpl = fetch,
  baseUrlValue = baseUrl(),
  apiKeyValue = payoutApiKey(),
} = {}) {
  const normalizedCurrency = String(currency || "INR").trim().toUpperCase();
  const url = new URL(`${String(baseUrlValue).replace(/\/$/, "")}/api/public/v1/balance`);
  url.searchParams.set("currency", normalizedCurrency);

  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      "x-api-key": apiKeyValue,
      accept: "application/json",
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw providerError(data, response, `Sunpay payout-balance failed (${response.status}).`);
  }

  return {
    currency: String(data?.currency || normalizedCurrency).toUpperCase(),
    balance: Number(data?.balance),
    upstreamBalance: data?.upstream_balance == null ? null : Number(data.upstream_balance),
  };
}
