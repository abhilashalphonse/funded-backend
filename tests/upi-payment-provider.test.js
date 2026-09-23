import test from "node:test";
import assert from "node:assert/strict";

import {
  getDailyUsdInrQuote,
  usdToInrQuote,
} from "../src/apis/services/paymentProviders/upiFx.service.js";
import { normalizeRupexStatus } from "../src/apis/services/paymentProviders/rupex.service.js";
import { normalizeSunpayStatus } from "../src/apis/services/paymentProviders/sunpay.service.js";

test("normalizes the documented Rupex lifecycle into ACG payment states", () => {
  assert.equal(normalizeRupexStatus("PENDING"), "WAITING");
  assert.equal(normalizeRupexStatus("APPROVED"), "CONFIRMING");
  assert.equal(normalizeRupexStatus("PROCESSING"), "CONFIRMING");
  assert.equal(normalizeRupexStatus("SUCCESS"), "PAID");
  assert.equal(normalizeRupexStatus("REJECTED"), "REFUNDED");
  assert.equal(normalizeRupexStatus("UNKNOWN"), "WAITING");
});

test("converts USD challenge price directly to INR using the daily USD/INR quote", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return [
        { date: "2026-09-22", base: "USD", quote: "INR", rate: 90 },
      ];
    },
  });

  try {
    const fx = await getDailyUsdInrQuote({ forceRefresh: true });
    assert.equal(fx.usdToInr, 90);
    assert.equal(fx.baseCurrency, "USD");
    assert.equal(fx.quoteCurrency, "INR");

    const quote = await usdToInrQuote(49);
    assert.equal(quote.amountInr, 4410);
    assert.equal(quote.quoteDate, "2026-09-22");
  } finally {
    global.fetch = originalFetch;
  }
});


test("normalizes the documented Sunpay pay-in lifecycle into ACG payment states", () => {
  assert.equal(normalizeSunpayStatus("pending"), "WAITING");
  assert.equal(normalizeSunpayStatus("processing"), "CONFIRMING");
  assert.equal(normalizeSunpayStatus("success"), "PAID");
  assert.equal(normalizeSunpayStatus("failed"), "FAILED");
  assert.equal(normalizeSunpayStatus("expired"), "EXPIRED");
  assert.equal(normalizeSunpayStatus("unknown"), "WAITING");
});
