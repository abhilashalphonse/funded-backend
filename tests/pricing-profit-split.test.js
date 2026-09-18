import test from "node:test";
import assert from "node:assert/strict";

import { calculatePrice, validateChallengeConfiguration } from "../src/pricing/pricingEngine.js";

const challengeDefinition = {
  step: "2step",
  accountSize: 50000,
  rules: {
    phase1ProfitTarget: 8,
    phase2ProfitTarget: 6,
    dailyLoss: 5,
    maxLoss: 10,
    minTradingDays: 3,
  },
};

const commercial = (profitSplit) => ({
  profitSplit,
  payoutFrequency: "Biweekly",
  newsTrading: false,
  weekendHolding: false,
});

test("profit split options are 60, 80 and 90", () => {
  for (const profitSplit of [60, 80, 90]) {
    const validation = validateChallengeConfiguration({
      ...challengeDefinition,
      commercial: commercial(profitSplit),
    });
    assert.equal(validation.valid, true);
  }

  const legacy = validateChallengeConfiguration({
    ...challengeDefinition,
    commercial: commercial(100),
  });
  assert.equal(legacy.valid, false);
  assert.equal(legacy.errors.some((error) => error.field === "profitSplit"), true);
});

test("lower profit split costs less and higher profit split costs more", () => {
  const price60 = calculatePrice(challengeDefinition, commercial(60)).finalPrice;
  const price80 = calculatePrice(challengeDefinition, commercial(80)).finalPrice;
  const price90 = calculatePrice(challengeDefinition, commercial(90)).finalPrice;

  assert.ok(price60 < price80);
  assert.ok(price80 < price90);
});
