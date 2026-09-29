import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_UPI_GATEWAY_ID,
  getUpiGateway,
  getUpiPayinAvailability,
  normalizeUpiGatewayId,
  normalizeUpiPayinAmount,
} from "../src/apis/services/paymentProviders/upiGateway.registry.js";

test("Rupex is the default UPI gateway and legacy ids remain compatible", () => {
  assert.equal(DEFAULT_UPI_GATEWAY_ID, "rupex");
  assert.equal(normalizeUpiGatewayId("upi-gateway"), "rupex");
  assert.equal(normalizeUpiGatewayId("upi_gateway"), "rupex");
  assert.equal(normalizeUpiGatewayId("upi_gateway_1"), "rupex");
  assert.equal(getUpiGateway("rupex", { requireAvailable: false }).label, "Rupex");
});

test("Sunpay is registered as an implemented gateway", () => {
  assert.equal(normalizeUpiGatewayId("upi_gateway_2"), "sunpay");
  const gateway = getUpiGateway("sunpay", { requireAvailable: false });
  assert.equal(gateway.label, "Sunpay");
  assert.equal(gateway.implemented, true);
  assert.equal(gateway.supportsStatusPolling, false);
  assert.equal(typeof gateway.createOrder, "function");
  assert.equal(typeof gateway.verifyWebhook, "function");
});


test("Sunpay normalizes pay-ins to whole INR and enforces ₹100–₹50,000", () => {
  const gateway = getUpiGateway("sunpay", { requireAvailable: false });

  assert.equal(normalizeUpiPayinAmount(gateway, 18104.31), 18105);
  assert.equal(getUpiPayinAvailability(gateway, 100).available, true);
  assert.equal(getUpiPayinAvailability(gateway, 50000).available, true);
  assert.equal(getUpiPayinAvailability(gateway, 99).reason, "AMOUNT_BELOW_GATEWAY_LIMIT");
  assert.equal(getUpiPayinAvailability(gateway, 50001).reason, "AMOUNT_ABOVE_GATEWAY_LIMIT");
  assert.equal(getUpiPayinAvailability(gateway, 18104.31).reason, "WHOLE_INR_REQUIRED");
});

test("Rupex keeps decimal INR behavior independent from Sunpay rules", () => {
  const gateway = getUpiGateway("rupex", { requireAvailable: false });
  assert.equal(normalizeUpiPayinAmount(gateway, 18104.31), 18104.31);
  assert.equal(getUpiPayinAvailability(gateway, 18104.31).available, true);
});
