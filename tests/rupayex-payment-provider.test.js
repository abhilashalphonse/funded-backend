import test from "node:test";
import assert from "node:assert/strict";

import {
  eurToInr,
  normalizeRupayexStatus,
} from "../src/apis/services/paymentProviders/rupayex.service.js";

test("normalizes Rupayex statuses into ACG payment states", () => {
  assert.equal(normalizeRupayexStatus("SUCCESS"), "PAID");
  assert.equal(normalizeRupayexStatus("PENDING"), "WAITING");
  assert.equal(normalizeRupayexStatus("REJECTED"), "FAILED");
  assert.equal(normalizeRupayexStatus("EXPIRED"), "EXPIRED");
});

test("converts EUR challenge amount to the configured INR amount", () => {
  const previous = process.env.RUPAYEX_INR_PER_EUR;
  process.env.RUPAYEX_INR_PER_EUR = "105.25";
  try {
    assert.equal(eurToInr(49), 5157.25);
  } finally {
    if (previous === undefined) delete process.env.RUPAYEX_INR_PER_EUR;
    else process.env.RUPAYEX_INR_PER_EUR = previous;
  }
});
