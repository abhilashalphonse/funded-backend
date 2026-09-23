import env from "../../../config/env.js";

function rupexBaseUrl() {
  const value = String(env.RUPEX_BASE_URL || "").trim().replace(/\/$/, "");
  if (!value) {
    const error = new Error("Rupex is not configured.");
    error.status = 503;
    error.code = "RUPEX_NOT_CONFIGURED";
    throw error;
  }
  return value;
}

function rupexApiToken() {
  const token = String(env.RUPEX_API_TOKEN || "").trim();
  if (!token) {
    const error = new Error("RUPEX_API_TOKEN is not configured.");
    error.status = 503;
    error.code = "RUPEX_NOT_CONFIGURED";
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

export async function createRupexOrder({ amountInr, orderId, redirectUrl, customerMobile, remark1 }) {
  const form = new URLSearchParams({
    user_token: rupexApiToken(),
    amount: Number(amountInr).toFixed(2),
    order_id: String(orderId),
    redirect_url: String(redirectUrl),
  });

  if (customerMobile) form.set("customer_mobile", String(customerMobile));
  if (remark1) form.set("remark1", String(remark1));

  const response = await fetch(`${rupexBaseUrl()}/api/create-order`, {
    method: "POST",
    headers: {
      "X-Api-Token": rupexApiToken(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });

  const text = await response.text();
  const data = parseJsonSafely(text);
  if (!response.ok || data?.status === false) {
    const error = new Error(data?.message || `Rupex create-order failed (${response.status}).`);
    error.status = response.status >= 400 ? response.status : 502;
    error.code = "RUPEX_CREATE_ORDER_FAILED";
    throw error;
  }

  const checkoutUrl = extractCheckoutUrl(data);
  if (!checkoutUrl) {
    const error = new Error("Rupex create-order did not return a checkout URL.");
    error.status = 502;
    error.code = "RUPEX_CHECKOUT_URL_MISSING";
    throw error;
  }

  return { data, checkoutUrl };
}

export async function getRupexOrderStatus(orderId) {
  const url = new URL(`${rupexBaseUrl()}/api/order-status`);
  url.searchParams.set("user_token", rupexApiToken());
  url.searchParams.set("order_id", String(orderId));

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  const text = await response.text();
  const data = parseJsonSafely(text);
  if (!response.ok || data?.status === false) {
    const error = new Error(data?.message || `Rupex order-status failed (${response.status}).`);
    error.status = response.status >= 400 ? response.status : 502;
    error.code = "RUPEX_STATUS_FAILED";
    throw error;
  }

  return data;
}

export function normalizeRupexStatus(value) {
  const status = String(value || "").trim().toUpperCase();
  if (status === "PENDING") return "WAITING";
  if (status === "APPROVED") return "CONFIRMING";
  if (status === "PROCESSING") return "CONFIRMING";
  if (status === "SUCCESS") return "PAID";
  if (status === "REJECTED") return "REFUNDED";
  return "WAITING";
}
