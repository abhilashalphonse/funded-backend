const FX_BASE_URL = "https://api.frankfurter.dev";
const FX_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let fxCache = null;

export async function getDailyUsdInrQuote({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && fxCache && now - fxCache.fetchedAt < FX_CACHE_TTL_MS) {
    return fxCache.value;
  }

  let response;
  try {
    response = await fetch(`${FX_BASE_URL}/v2/rates?base=usd&quotes=inr`, {
      headers: { Accept: "application/json" },
    });
  } catch (cause) {
    if (fxCache?.value) return { ...fxCache.value, stale: true };
    const error = new Error("Daily FX quote request failed.");
    error.status = 502;
    error.code = "FX_QUOTE_FAILED";
    error.cause = cause;
    throw error;
  }

  const data = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(data)) {
    if (fxCache?.value) return { ...fxCache.value, stale: true };
    const error = new Error(`Daily FX quote request failed (${response.status}).`);
    error.status = 502;
    error.code = "FX_QUOTE_FAILED";
    throw error;
  }

  const rates = Object.fromEntries(
    data.map(row => [String(row?.quote || "").toUpperCase(), Number(row?.rate)]),
  );
  const usdToInr = rates.INR;
  if (!Number.isFinite(usdToInr) || usdToInr <= 0) {
    if (fxCache?.value) return { ...fxCache.value, stale: true };
    const error = new Error("Daily FX response is missing a valid USD/INR rate.");
    error.status = 502;
    error.code = "FX_QUOTE_INVALID";
    throw error;
  }

  const quoteDate = data.find(row => row?.date)?.date || new Date().toISOString().slice(0, 10);
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
