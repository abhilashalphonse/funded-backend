import test from "node:test";
import assert from "node:assert/strict";

import {
  eurToInrQuote,
  getDailyUsdFxQuote,
  normalizeRupayexStatus,
} from "../src/apis/services/paymentProviders/rupayex.service.js";

test("normalizes Rupayex statuses into ACG payment states", () => {
  assert.equal(normalizeRupayexStatus("SUCCESS"), "PAID");
  assert.equal(normalizeRupayexStatus("PENDING"), "WAITING");
  assert.equal(normalizeRupayexStatus("REJECTED"), "FAILED");
  assert.equal(normalizeRupayexStatus("EXPIRED"), "EXPIRED");
});

test("derives EUR to INR from the daily USD base quote", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return [
        { date: "2026-09-22", base: "USD", quote: "EUR", rate: 0.9 },
        { date: "2026-09-22", base: "USD", quote: "INR", rate: 90 },
      ];
    },
  });

  try {
    const fx = await getDailyUsdFxQuote({ forceRefresh: true });
    assert.equal(fx.usdToEur, 0.9);
    assert.equal(fx.usdToInr, 90);
    assert.equal(fx.eurToInr, 100);

    const quote = await eurToInrQuote(49);
    assert.equal(quote.amountInr, 4900);
    assert.equal(quote.quoteDate, "2026-09-22");
  } finally {
    global.fetch = originalFetch;
  }
});
