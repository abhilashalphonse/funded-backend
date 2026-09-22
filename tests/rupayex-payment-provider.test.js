import test from "node:test";
import assert from "node:assert/strict";

import {
  getDailyUsdInrQuote,
  normalizeRupayexStatus,
  usdToInrQuote,
} from "../src/apis/services/paymentProviders/rupayex.service.js";

test("normalizes Rupayex statuses into ACG payment states", () => {
  assert.equal(normalizeRupayexStatus("SUCCESS"), "PAID");
  assert.equal(normalizeRupayexStatus("PENDING"), "WAITING");
  assert.equal(normalizeRupayexStatus("REJECTED"), "FAILED");
  assert.equal(normalizeRupayexStatus("EXPIRED"), "EXPIRED");
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
