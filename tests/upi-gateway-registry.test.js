import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_UPI_GATEWAY_ID,
  getUpiGateway,
  normalizeUpiGatewayId,
} from "../src/apis/services/paymentProviders/upiGateway.registry.js";

test("legacy UPI provider ids resolve to gateway 1", () => {
  assert.equal(normalizeUpiGatewayId("upi-gateway"), DEFAULT_UPI_GATEWAY_ID);
  assert.equal(normalizeUpiGatewayId("upi_gateway"), DEFAULT_UPI_GATEWAY_ID);
  assert.equal(
    getUpiGateway("upi-gateway", { requireAvailable: false }).id,
    DEFAULT_UPI_GATEWAY_ID,
  );
});

test("gateway 2 is registered but cannot be activated before its adapter exists", () => {
  const gateway = getUpiGateway("upi_gateway_2", { requireAvailable: false });
  assert.equal(gateway.implemented, false);
  assert.throws(
    () => getUpiGateway("upi_gateway_2"),
    error => error?.code === "UPI_GATEWAY_NOT_INTEGRATED",
  );
});
