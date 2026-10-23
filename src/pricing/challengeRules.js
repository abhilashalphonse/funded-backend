// New purchases use these bounds and commercial adjustments. Existing paid orders retain their saved terms.
export const PRICING_VERSION = "2026-10-challenge-v3";

export const STEP_TYPES = {
  ONE_STEP: "1step",
  TWO_STEP: "2step",
};

export const ACCOUNT_SIZE_CONFIG = {
  [STEP_TYPES.ONE_STEP]: { min: 5000, max: 100000, step: 500 },
  [STEP_TYPES.TWO_STEP]: { min: 5000, max: 200000, step: 500 },
};

export const RULE_BOUNDS = {
  profitTarget: { min: 10, max: 12, increment: 1 },
  phase1ProfitTarget: { min: 8, max: 12, increment: 1 },
  phase2ProfitTarget: { min: 6, max: 12, increment: 1 },
  dailyLoss: { min: 2, max: 5, increment: 1 },
  maxLoss: { min: 5, max: 12, increment: 1 },
  minTradingDays: { min: 3, max: 5, increment: 1 },
};

export const PROFIT_SPLIT_OPTIONS = [60, 80, 90];
export const PAYOUT_FREQUENCY_OPTIONS = ["Monthly", "Biweekly", "Weekly", "On Demand"];

export const BASE_PRICE_CURVES = {
  [STEP_TYPES.ONE_STEP]: [
    { size: 5000, price: 39 }, { size: 10000, price: 69 },
    { size: 25000, price: 149 }, { size: 50000, price: 269 },
    { size: 75000, price: 379 }, { size: 100000, price: 499 },
  ],
  [STEP_TYPES.TWO_STEP]: [
    { size: 5000, price: 29 }, { size: 10000, price: 49 },
    { size: 25000, price: 99 }, { size: 50000, price: 189 },
    { size: 100000, price: 349 }, { size: 150000, price: 499 },
    { size: 200000, price: 649 },
  ],
};

export const ADJUSTMENT_TABLES = {
  [STEP_TYPES.ONE_STEP]: {
    profitTarget: { 10: 0, 11: -.04, 12: -.08 },
    dailyLoss: { 2: -.06, 3: 0, 4: .10, 5: .21 },
    maxLoss: { 5: -.05, 6: 0, 7: .08, 8: .16, 9: .25, 10: .35, 11: .45, 12: .55 },
    minTradingDays: { 3: 0, 4: -.05, 5: -.08 },
  },
  [STEP_TYPES.TWO_STEP]: {
    phase1ProfitTarget: { 8: 0, 9: -0.02, 10: -0.04, 11: -0.06, 12: -0.08 },
    phase2ProfitTarget: { 6: 0, 7: -0.02, 8: -0.04, 9: -0.06, 10: -0.08, 11: -0.1, 12: -0.12 },
    dailyLoss: { 2: -0.06, 3: -0.03, 4: -0.015, 5: 0 },
    maxLoss: { 5: -0.1, 6: -0.075, 7: -0.05, 8: -0.03, 9: -0.015, 10: 0, 11: 0.1, 12: 0.2 },
    minTradingDays: { 3: 0, 4: -.05, 5: -.08 },
  },
};

export const PROFIT_SPLIT_ADJUSTMENTS = { 60: -.12, 80: 0, 90: .12 };
export const PAYOUT_ADJUSTMENTS = { Monthly: -.05, Biweekly: 0, Weekly: .10, "On Demand": .22 };
// Only 2-Step receives reduced discount stacking. 1-Step retains its existing commercial prices.
export const TWO_STEP_PROFIT_SPLIT_ADJUSTMENTS = { 60: -.06, 80: 0, 90: .12 };
export const TWO_STEP_PAYOUT_ADJUSTMENTS = { Monthly: -.02, Biweekly: 0, Weekly: .10, "On Demand": .22 };
export const NEWS_TRADING_ADJUSTMENT = .07;
export const WEEKEND_HOLDING_ADJUSTMENT = .05;
export const PRICE_MULTIPLIER_FLOOR = .70;
export const PRICE_MULTIPLIER_CEILING = 1.95;
export const PSYCHOLOGICAL_PRICES = [29,39,49,59,69,79,89,99,129,149,169,189,219,239,269,299,349,379,399,449,499,549,599,649,699,749];
