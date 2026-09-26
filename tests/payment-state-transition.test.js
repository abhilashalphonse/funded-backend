import test from "node:test";
import assert from "node:assert/strict";

import { isExpectedNowPaymentsFiatCurrency, nextPaymentStatus } from "../src/apis/services/payment.service.js";

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


test("legacy NOWPayments crypto invoices accept signed EUR callbacks until provider currency is pinned", () => {
  const legacy = {
    provider: "nowpayments",
    paymentMethod: "BTC",
    currency: "USD",
    providerCurrency: null,
  };

  assert.equal(isExpectedNowPaymentsFiatCurrency(legacy, "EUR"), true);
  assert.equal(isExpectedNowPaymentsFiatCurrency(legacy, "USD"), true);
  assert.equal(isExpectedNowPaymentsFiatCurrency(legacy, "GBP"), false);
});

test("new NOWPayments crypto invoices are strict once provider currency is stored", () => {
  const current = {
    provider: "nowpayments",
    paymentMethod: "USDT_TRX",
    currency: "USD",
    providerCurrency: "USD",
  };

  assert.equal(isExpectedNowPaymentsFiatCurrency(current, "USD"), true);
  assert.equal(isExpectedNowPaymentsFiatCurrency(current, "EUR"), false);
});

test("non-NOWPayments payments do not get the legacy fiat compatibility bridge", () => {
  const upi = {
    provider: "rupex",
    paymentMethod: "UPI",
    currency: "USD",
    providerCurrency: null,
  };

  assert.equal(isExpectedNowPaymentsFiatCurrency(upi, "USD"), true);
  assert.equal(isExpectedNowPaymentsFiatCurrency(upi, "EUR"), false);
});
