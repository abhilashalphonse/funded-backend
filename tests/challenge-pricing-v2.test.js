import test from "node:test";
import assert from "node:assert/strict";
import { RULE_BOUNDS, ADJUSTMENT_TABLES, PRICE_MULTIPLIER_FLOOR, PRICING_VERSION } from "../src/pricing/challengeRules.js";
import { calculatePrice, validateChallengeConfiguration } from "../src/pricing/pricingEngine.js";


const commercial = Object.freeze({
  profitSplit: 80,
  payoutFrequency: "Biweekly",
  newsTrading: false,
  weekendHolding: false,
});

const defaults = {
  "1step": { profitTarget: 10, dailyLoss: 3, maxLoss: 6, minTradingDays: 3 },
  "2step": { phase1ProfitTarget: 8, phase2ProfitTarget: 6, dailyLoss: 5, maxLoss: 10, minTradingDays: 3 },
};

function definition(step, changes = {}) {
  return { step, accountSize: 50000, rules: { ...defaults[step], ...changes } };
}
function quote(step, changes = {}) {
  return calculatePrice(definition(step, changes), commercial);
}
function accepted(step, changes = {}) {
  return validateChallengeConfiguration({ ...definition(step, changes), commercial }).valid;
}
function values({ min, max, increment }) {
  return Array.from({ length: (max - min) / increment + 1 }, (_, i) => min + i * increment);
}

test("approved ranges apply while 1-/2-step default terms are preserved", () => {
  assert.deepEqual(RULE_BOUNDS.profitTarget, { min: 10, max: 12, increment: 1 });
  assert.deepEqual(RULE_BOUNDS.phase1ProfitTarget, { min: 8, max: 12, increment: 1 });
  assert.deepEqual(RULE_BOUNDS.phase2ProfitTarget, { min: 6, max: 12, increment: 1 });
  assert.deepEqual(RULE_BOUNDS.dailyLoss, { min: 2, max: 5, increment: 1 });
  assert.deepEqual(RULE_BOUNDS.maxLoss, { min: 5, max: 12, increment: 1 });
  assert.deepEqual(RULE_BOUNDS.minTradingDays, { min: 3, max: 5, increment: 1 });
  assert.equal(PRICE_MULTIPLIER_FLOOR, 0.70);
  assert.equal(PRICING_VERSION, "2026-10-challenge-v3");
  assert.equal(quote("1step").finalPrice, 269);
  assert.equal(quote("2step").finalPrice, 189);
  assert.equal(quote("1step").pricingVersion, PRICING_VERSION);
  assert.equal(quote("2step").pricingVersion, PRICING_VERSION);
});

test("validation disallows retired target selections and allows 12% maximum loss", () => {
  assert.equal(accepted("1step", { profitTarget: 9 }), false);
  assert.equal(accepted("2step", { phase1ProfitTarget: 7 }), false);
  assert.equal(accepted("2step", { phase2ProfitTarget: 5 }), false);
  assert.equal(accepted("1step", { maxLoss: 13 }), false);
  assert.equal(accepted("2step", { maxLoss: 13 }), false);
  assert.equal(accepted("1step", { profitTarget: 12, maxLoss: 12 }), true);
  assert.equal(accepted("2step", { phase1ProfitTarget: 12, phase2ProfitTarget: 12, maxLoss: 12 }), true);
  assert.equal(accepted("1step", { dailyLoss: 5, maxLoss: 5 }), true);
  assert.equal(accepted("2step", { dailyLoss: 5, maxLoss: 5 }), true);
  assert.equal(accepted("2step", { dailyLoss: 5, maxLoss: 4 }), false);
});

test("pricing adjustment tables cover exactly the permitted whole-percent choices", () => {
  for (const step of ["1step", "2step"]) {
    const tables = ADJUSTMENT_TABLES[step];
    const fields = step === "1step"
      ? ["profitTarget", "dailyLoss", "maxLoss", "minTradingDays"]
      : ["phase1ProfitTarget", "phase2ProfitTarget", "dailyLoss", "maxLoss", "minTradingDays"];
    for (const field of fields) {
      const actual = Object.keys(tables[field]).map(Number).sort((a,b) => a-b);
      assert.deepEqual(actual, values(RULE_BOUNDS[field]), step + "/" + field);
    }
  }
});

test("representative USD prices and discount floor are exact", () => {
  assert.equal(quote("1step", { profitTarget: 12 }).finalPrice, 247);
  assert.equal(quote("1step", { maxLoss: 12 }).finalPrice, 417);
  assert.equal(quote("2step", { phase1ProfitTarget: 10, phase2ProfitTarget: 8 }).finalPrice, 174);
  assert.equal(quote("2step", { maxLoss: 12 }).finalPrice, 227);
  assert.equal(quote("2step", { phase1ProfitTarget: 12, phase2ProfitTarget: 12 }).finalPrice, 151);
  assert.equal(quote("2step", { phase1ProfitTarget: 12, phase2ProfitTarget: 11 }).finalPrice, 155);
  const hardest = quote("2step", { phase1ProfitTarget: 12, phase2ProfitTarget: 12, dailyLoss: 2, maxLoss: 5, minTradingDays: 5 });
  assert.equal(hardest.finalPrice, 132);
  assert.equal(hardest.multiplier, PRICE_MULTIPLIER_FLOOR);
});

test("every permitted target/risk combination is priced and respects the pre-promotion floor", () => {
  let checked = 0;
  for (const step of ["1step", "2step"]) {
    const firstTargets = values(RULE_BOUNDS[step === "1step" ? "profitTarget" : "phase1ProfitTarget"]);
    const secondTargets = step === "1step" ? [null] : values(RULE_BOUNDS.phase2ProfitTarget);
    for (const first of firstTargets) for (const second of secondTargets)
      for (const dailyLoss of values(RULE_BOUNDS.dailyLoss))
        for (const minTradingDays of values(RULE_BOUNDS.minTradingDays)) {
          let prior = -Infinity;
          for (const maxLoss of values(RULE_BOUNDS.maxLoss)) {
            const changes = step === "1step"
              ? { profitTarget: first, dailyLoss, maxLoss, minTradingDays }
              : { phase1ProfitTarget: first, phase2ProfitTarget: second, dailyLoss, maxLoss, minTradingDays };
            const d = definition(step, changes);
            const validation = validateChallengeConfiguration({ ...d, commercial });
            assert.equal(validation.valid, true, JSON.stringify({ step, changes, errors: validation.errors }));
            const result = calculatePrice(d, commercial);
            assert.ok(Number.isInteger(result.finalPrice) && result.finalPrice > 0);
            assert.ok(result.multiplier >= PRICE_MULTIPLIER_FLOOR - 1e-10);
            assert.ok(result.finalPrice >= prior, "larger max loss cannot reduce the price");
            prior = result.finalPrice;
            checked++;
          }
        }
  }
  assert.equal(checked, 3648);
});

function* twoStepRules() {
  for (const phase1ProfitTarget of values(RULE_BOUNDS.phase1ProfitTarget))
    for (const phase2ProfitTarget of values(RULE_BOUNDS.phase2ProfitTarget))
      for (const dailyLoss of values(RULE_BOUNDS.dailyLoss))
        for (const maxLoss of values(RULE_BOUNDS.maxLoss))
          for (const minTradingDays of values(RULE_BOUNDS.minTradingDays))
            yield { phase1ProfitTarget, phase2ProfitTarget, dailyLoss, maxLoss, minTradingDays };
}

test("fewer than 10% of standard 2-step combinations reach the multiplier floor", () => {
  let checked = 0;
  let atFloor = 0;
  for (const rules of twoStepRules()) {
    const result = quote("2step", rules);
    if (result.multiplier <= PRICE_MULTIPLIER_FLOOR + 1e-10) atFloor++;
    // Harder rules must never increase a quote, including at the floor.
    for (const field of ["phase1ProfitTarget", "phase2ProfitTarget", "minTradingDays"]) {
      if (rules[field] < RULE_BOUNDS[field].max) {
        const harder = quote("2step", { ...rules, [field]: rules[field] + 1 });
        assert.ok(harder.finalPrice <= result.finalPrice, field);
      }
    }
    checked++;
  }
  assert.equal(checked, 3360);
  assert.equal(atFloor, 328);
  assert.ok(atFloor / checked < 0.10);
});
