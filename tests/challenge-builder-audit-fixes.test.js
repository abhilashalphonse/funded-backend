import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTrialChallenge } from "../src/apis/services/customer.service.js";
import { assertConfirmedCheckoutPrice, getChallengeQuote } from "../src/apis/services/payment.service.js";
import { calculatePrice } from "../src/pricing/pricingEngine.js";
import { PRICING_VERSION } from "../src/pricing/challengeRules.js";

const definition = {
  step: "2step", accountSize: 50000,
  rules: { phase1ProfitTarget: 8, phase2ProfitTarget: 6, dailyLoss: 5, maxLoss: 10, minTradingDays: 3 },
};
const commercial = { profitSplit: 80, payoutFrequency: "Biweekly", newsTrading: false, weekendHolding: false };

test("USD quote is priced by backend without needing a UPI provider", () => {
  const quote = getChallengeQuote({ challengeDefinition: definition, commercialConfig: commercial });
  assert.deepEqual(quote, { amount: 189, currency: "USD", pricingVersion: PRICING_VERSION });
  assert.equal(calculatePrice(definition, commercial).finalPrice, quote.amount);
});

test("payment creation must receive a confirmed authoritative price and version", () => {
  const pricing = calculatePrice(definition, commercial);
  assert.doesNotThrow(() => assertConfirmedCheckoutPrice(pricing, {
    confirmedPrice: pricing.finalPrice, confirmedPricingVersion: pricing.pricingVersion,
  }));
  for (const input of [
    {},
    { confirmedPrice: 108, confirmedPricingVersion: pricing.pricingVersion },
    { confirmedPrice: 189, confirmedPricingVersion: "old-pricing-version" },
    { confirmedPrice: "189", confirmedPricingVersion: pricing.pricingVersion },
    { confirmedPrice: null, confirmedPricingVersion: pricing.pricingVersion },
  ]) {
    assert.throws(() => assertConfirmedCheckoutPrice(pricing, input), e =>
      e.status === 409 && ["CHECKOUT_PRICE_CHANGED", "CHECKOUT_PRICE_CONFIRMATION_REQUIRED"].includes(e.code));
  }
});

test("trial defaults match the currently approved paid challenge rules", () => {
  const two = normalizeTrialChallenge();
  assert.equal(two.step, "2step");
  assert.equal(two.accountSize, 100000);
  assert.deepEqual(two.rules, { phase1ProfitTarget: 8, phase2ProfitTarget: 6, dailyLoss: 5, maxLoss: 10, minTradingDays: 3 });
  const one = normalizeTrialChallenge({ step: "1step", accountSize: 25000 });
  assert.deepEqual(one.rules, { profitTarget: 10, dailyLoss: 3, maxLoss: 6, minTradingDays: 3 });
});

test("trial request validates client input, including target, loss, days and account size", () => {
  const cases = [
    { step: "2step", accountSize: 50000, rules: { phase2ProfitTarget: 5 } },
    { step: "1step", accountSize: 50000, rules: { profitTarget: 9 } },
    { step: "2step", accountSize: 50000, rules: { maxLoss: 13 } },
    { step: "2step", accountSize: 50000, rules: { minTradingDays: 0 } },
    { step: "2step", accountSize: 250000 },
    { step: "1step", accountSize: 100001 },
    { step: "fake", accountSize: 50000 },
    { step: "2step", accountSize: 50000, rules: { dailyLoss: 5, maxLoss: 4 } },
    { step: "2step", accountSize: 50000, rules: { maxLoss: "12" } },
    { step: "2step", accountSize: 50000, rules: null },
  ];
  for (const input of cases) {
    assert.throws(() => normalizeTrialChallenge(input), e => e.status === 400
      && e.code === "INVALID_TRIAL_CHALLENGE_CONFIGURATION", JSON.stringify(input));
  }
  const good = normalizeTrialChallenge({ step: "2step", accountSize: 200000, rules: { maxLoss: 12, phase2ProfitTarget: 12 } });
  assert.equal(good.rules.maxLoss, 12);
});

test("invalid paid challenge definitions now return client validation status", () => {
  const bad = { ...definition, rules: { ...definition.rules, maxLoss: 13 } };
  assert.throws(() => calculatePrice(bad, commercial), e => e.code === "INVALID_CHALLENGE_CONFIGURATION" && e.status === 400);
  assert.throws(() => getChallengeQuote({ challengeDefinition: bad, commercialConfig: commercial }), e => e.status === 400);
  assert.throws(() => calculatePrice({ ...definition, step: "invalid" }, commercial), e => e.status === 400);
});
