import test from "node:test";
import assert from "node:assert/strict";

import { nextPaymentStatus } from "../src/apis/services/payment.service.js";

test("payment state never regresses after confirmation", () => {
  assert.equal(nextPaymentStatus("PAID", "WAITING"), "PAID");
  assert.equal(nextPaymentStatus("PAID", "CONFIRMING"), "PAID");
  assert.equal(nextPaymentStatus("PAID", "FAILED"), "PAID");
  assert.equal(nextPaymentStatus("PAID", "EXPIRED"), "PAID");
  assert.equal(nextPaymentStatus("PAID", "REFUNDED"), "REFUNDED");
});

test("pending payment state only moves forward", () => {
  assert.equal(nextPaymentStatus("WAITING", "CREATED"), "WAITING");
  assert.equal(nextPaymentStatus("CONFIRMING", "WAITING"), "CONFIRMING");
  assert.equal(nextPaymentStatus("WAITING", "CONFIRMING"), "CONFIRMING");
  assert.equal(nextPaymentStatus("FAILED", "WAITING"), "FAILED");
  assert.equal(nextPaymentStatus("EXPIRED", "PAID"), "PAID");
});
