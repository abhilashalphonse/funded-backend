import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_UPI_GATEWAY_ID,
  getUpiGateway,
  normalizeUpiGatewayId,
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
