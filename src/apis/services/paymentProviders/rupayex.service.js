const RUPAYEX_BASE_URL = "https://rupayex.net";

function apiToken() {
  const token = String(process.env.RUPAYEX_API_TOKEN || "").trim();
  if (!token) {
    const error = new Error("RUPAYEX_API_TOKEN is not configured.");
    error.status = 503;
    error.code = "RUPAYEX_NOT_CONFIGURED";
    throw error;
  }
  return token;
}

function parseJsonSafely(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

function extractCheckoutUrl(data) {
  return data?.checkout_url
    || data?.checkoutUrl
    || data?.payment_url
    || data?.paymentUrl
    || data?.redirect_url
    || data?.redirectUrl
    || data?.url
    || data?.data?.checkout_url
    || data?.data?.checkoutUrl
    || data?.data?.payment_url
    || data?.data?.paymentUrl
    || data?.data?.redirect_url
    || data?.data?.redirectUrl
    || data?.data?.url
    || null;
}

export function rupayexInrPerEur() {
  const rate = Number(process.env.RUPAYEX_INR_PER_EUR);
  if (!Number.isFinite(rate) || rate <= 0) {
    const error = new Error("RUPAYEX_INR_PER_EUR must be configured as a positive number.");
    error.status = 503;
    error.code = "RUPAYEX_FX_NOT_CONFIGURED";
    throw error;
  }
  return rate;
}

export function eurToInr(amountEur) {
  const amount = Number(amountEur);
  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error("A valid EUR payment amount is required.");
    error.status = 400;
    error.code = "INVALID_PAYMENT_AMOUNT";
    throw error;
  }

  // Rupayex accepts INR. Charge whole paise-compatible values and preserve
  // two decimal places so the exact provider amount can be verified later.
  return Number((amount * rupayexInrPerEur()).toFixed(2));
}

export async function createRupayexOrder({ amountInr, orderId, redirectUrl, customerMobile, remark1 }) {
  const form = new URLSearchParams({
    user_token: apiToken(),
    amount: Number(amountInr).toFixed(2),
    order_id: String(orderId),
    redirect_url: String(redirectUrl),
  });

  if (customerMobile) form.set("customer_mobile", String(customerMobile));
  if (remark1) form.set("remark1", String(remark1));

  const response = await fetch(`${RUPAYEX_BASE_URL}/api/create-order`, {
    method: "POST",
    headers: {
      "X-Api-Token": apiToken(),
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: form.toString(),
  });

  const text = await response.text();
  const data = parseJsonSafely(text);
  if (!response.ok || data?.status === false) {
    const error = new Error(data?.message || `Rupayex create-order failed (${response.status}).`);
    error.status = response.status >= 400 ? response.status : 502;
    error.code = "RUPAYEX_CREATE_ORDER_FAILED";
    throw error;
  }

  const checkoutUrl = extractCheckoutUrl(data);
  if (!checkoutUrl) {
    const error = new Error("Rupayex create-order did not return a checkout URL.");
    error.status = 502;
    error.code = "RUPAYEX_CHECKOUT_URL_MISSING";
    throw error;
  }

  return { data, checkoutUrl };
}

export async function getRupayexOrderStatus(orderId) {
  const url = new URL(`${RUPAYEX_BASE_URL}/api/order-status`);
  url.searchParams.set("user_token", apiToken());
  url.searchParams.set("order_id", String(orderId));

  const response = await fetch(url, {
    headers: { "Accept": "application/json" },
  });

  const text = await response.text();
  const data = parseJsonSafely(text);
  if (!response.ok || data?.status === false) {
    const error = new Error(data?.message || `Rupayex order-status failed (${response.status}).`);
    error.status = response.status >= 400 ? response.status : 502;
    error.code = "RUPAYEX_STATUS_FAILED";
    throw error;
  }

  return data;
}

export function normalizeRupayexStatus(value) {
  const status = String(value || "").trim().toUpperCase();
  if (status === "SUCCESS") return "PAID";
  if (["FAILED", "FAILURE", "REJECTED", "CANCELLED", "CANCELED"].includes(status)) return "FAILED";
  if (["EXPIRED"].includes(status)) return "EXPIRED";
  return "WAITING";
}
