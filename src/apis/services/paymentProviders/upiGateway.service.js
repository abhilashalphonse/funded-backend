function gatewayBaseUrl() {
  const value = String(process.env.UPI_GATEWAY_BASE_URL || "").trim().replace(/\/$/, "");
  if (!value) {
    const error = new Error("UPI payment gateway is not configured.");
    error.status = 503;
    error.code = "UPI_GATEWAY_NOT_CONFIGURED";
    throw error;
  }
  return value;
}
const FX_BASE_URL = "https://api.frankfurter.dev";
const FX_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let fxCache = null;

function apiToken() {
  const token = String(process.env.UPI_GATEWAY_API_TOKEN || "").trim();
  if (!token) {
    const error = new Error("UPI_GATEWAY_API_TOKEN is not configured.");
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

export async function getDailyUsdInrQuote({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && fxCache && now - fxCache.fetchedAt < FX_CACHE_TTL_MS) {
    return fxCache.value;
  }

  const response = await fetch(`${FX_BASE_URL}/v2/rates?base=usd&quotes=inr`, {
    headers: { Accept: "application/json" },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(data)) {
    const error = new Error(`Daily FX quote request failed (${response.status}).`);
    error.status = 502;
    error.code = "FX_QUOTE_FAILED";
    throw error;
  }

  const rates = Object.fromEntries(
    data.map((row) => [String(row?.quote || "").toUpperCase(), Number(row?.rate)]),
  );
  const usdToInr = rates.INR;
  if (!Number.isFinite(usdToInr) || usdToInr <= 0) {
    const error = new Error("Daily FX response is missing a valid USD/INR rate.");
    error.status = 502;
    error.code = "FX_QUOTE_INVALID";
    throw error;
  }

  const quoteDate = data.find((row) => row?.date)?.date || new Date().toISOString().slice(0, 10);
  const value = {
    source: "frankfurter",
    quoteDate,
    baseCurrency: "USD",
    quoteCurrency: "INR",
    usdToInr,
  };

  fxCache = { fetchedAt: now, value };
  return value;
}

export async function usdToInrQuote(amountUsd) {
  const amount = Number(amountUsd);
  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error("A valid USD payment amount is required.");
    error.status = 400;
    error.code = "INVALID_PAYMENT_AMOUNT";
    throw error;
  }

  const fx = await getDailyUsdInrQuote();
  return {
    amountInr: Number((amount * fx.usdToInr).toFixed(2)),
    ...fx,
  };
}

export async function createUpiOrder({ amountInr, orderId, redirectUrl, customerMobile, remark1 }) {
  const form = new URLSearchParams({
    user_token: apiToken(),
    amount: Number(amountInr).toFixed(2),
    order_id: String(orderId),
    redirect_url: String(redirectUrl),
  });

  if (customerMobile) form.set("customer_mobile", String(customerMobile));
  if (remark1) form.set("remark1", String(remark1));

  const response = await fetch(`${gatewayBaseUrl()}/api/create-order`, {
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
    const error = new Error(data?.message || `UPI gateway create-order failed (${response.status}).`);
    error.status = response.status >= 400 ? response.status : 502;
    error.code = "RUPAYEX_CREATE_ORDER_FAILED";
    throw error;
  }

  const checkoutUrl = extractCheckoutUrl(data);
  if (!checkoutUrl) {
    const error = new Error("UPI gateway create-order did not return a checkout URL.");
    error.status = 502;
    error.code = "RUPAYEX_CHECKOUT_URL_MISSING";
    throw error;
  }

  return { data, checkoutUrl };
}

export async function getUpiOrderStatus(orderId) {
  const url = new URL(`${gatewayBaseUrl()}/api/order-status`);
  url.searchParams.set("user_token", apiToken());
  url.searchParams.set("order_id", String(orderId));

  const response = await fetch(url, {
    headers: { "Accept": "application/json" },
  });

  const text = await response.text();
  const data = parseJsonSafely(text);
  if (!response.ok || data?.status === false) {
    const error = new Error(data?.message || `UPI gateway order-status failed (${response.status}).`);
    error.status = response.status >= 400 ? response.status : 502;
    error.code = "RUPAYEX_STATUS_FAILED";
    throw error;
  }

  return data;
}

export function normalizeUpiStatus(value) {
  const status = String(value || "").trim().toUpperCase();
  if (status === "SUCCESS") return "PAID";
  if (["FAILED", "FAILURE", "REJECTED", "CANCELLED", "CANCELED"].includes(status)) return "FAILED";
  if (["EXPIRED"].includes(status)) return "EXPIRED";
  return "WAITING";
}
