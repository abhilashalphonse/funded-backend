import {
  STEP_TYPES,
  ACCOUNT_SIZE_CONFIG,
  RULE_BOUNDS,
  BASE_PRICE_CURVES,
  ADJUSTMENT_TABLES,
  PROFIT_SPLIT_ADJUSTMENTS,
  PAYOUT_ADJUSTMENTS,
  NEWS_TRADING_ADJUSTMENT,
  WEEKEND_HOLDING_ADJUSTMENT,
  PROFIT_SPLIT_OPTIONS,
  PAYOUT_FREQUENCY_OPTIONS,
  PRICE_MULTIPLIER_FLOOR,
  PRICE_MULTIPLIER_CEILING,
  PSYCHOLOGICAL_PRICES,
} from "./challengeRules.js";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const roundCurrency = (v) => Math.round(v);

function adjustment(table, field, value) {
  if (!table || !Object.prototype.hasOwnProperty.call(table, value) || !Number.isFinite(table[value])) {
    throw new Error(`Missing pricing adjustment for ${field}=${value}.`);
  }
  return table[value];
}

function basePrice(accountSize, step) {
  const curve = BASE_PRICE_CURVES[step];
  if (!curve) throw new Error(`No base price curve exists for step ${step}.`);
  if (accountSize <= curve[0].size) return curve[0].price;
  if (accountSize >= curve[curve.length - 1].size) return curve[curve.length - 1].price;
  for (let i = 0; i < curve.length - 1; i += 1) {
    const a = curve[i];
    const b = curve[i + 1];
    if (accountSize >= a.size && accountSize <= b.size) {
      const ratio = (accountSize - a.size) / (b.size - a.size);
      return a.price + ratio * (b.price - a.price);
    }
  }
  throw new Error("Unable to calculate base price.");
}

function psychological(raw) {
  const match = PSYCHOLOGICAL_PRICES.find((p) => p >= raw);
  if (match !== undefined) return match;
  return Math.max(1, Math.ceil(raw / 50) * 50 - 1);
}

export function validateChallengeConfiguration({ step, accountSize, rules, commercial }) {
  const errors = [];
  if (!Object.values(STEP_TYPES).includes(step)) errors.push({ field: "step", message: "Unknown challenge type." });

  const size = ACCOUNT_SIZE_CONFIG[step];
  if (!Number.isFinite(accountSize)) errors.push({ field: "accountSize", message: "Account size must be a finite number." });
  else if (accountSize < size.min || accountSize > size.max) errors.push({ field: "accountSize", message: "Account size is outside the allowed range." });
  else if ((accountSize - size.min) % size.step !== 0) errors.push({ field: "accountSize", message: "Account size uses an invalid increment." });

  const fields = step === STEP_TYPES.TWO_STEP
    ? ["phase1ProfitTarget", "phase2ProfitTarget", "dailyLoss", "maxLoss", "minTradingDays"]
    : ["profitTarget", "dailyLoss", "maxLoss", "minTradingDays"];

  if (!isObject(rules)) errors.push({ field: "rules", message: "Challenge rules are required." });
  else {
    for (const field of fields) {
      const bounds = RULE_BOUNDS[field];
      const value = rules[field];
      if (!Number.isFinite(value)) errors.push({ field, message: `${field} must be a number.` });
      else if (value < bounds.min || value > bounds.max || (value - bounds.min) % bounds.increment !== 0) {
        errors.push({ field, message: `${field} is outside the allowed range.` });
      }
    }
    if (Number.isFinite(rules.dailyLoss) && Number.isFinite(rules.maxLoss) && rules.dailyLoss > rules.maxLoss) {
      errors.push({ field: "dailyLoss", message: "Daily Loss cannot be greater than Maximum Loss." });
    }
  }

  if (!isObject(commercial)) errors.push({ field: "commercial", message: "Commercial configuration is required." });
  else {
    if (!PROFIT_SPLIT_OPTIONS.includes(commercial.profitSplit)) errors.push({ field: "profitSplit", message: "Unsupported profit split." });
    if (!PAYOUT_FREQUENCY_OPTIONS.includes(commercial.payoutFrequency)) errors.push({ field: "payoutFrequency", message: "Unsupported payout frequency." });
    if (typeof commercial.newsTrading !== "boolean") errors.push({ field: "newsTrading", message: "News Trading must be boolean." });
    if (typeof commercial.weekendHolding !== "boolean") errors.push({ field: "weekendHolding", message: "Weekend Holding must be boolean." });
  }
  return { valid: errors.length === 0, errors };
}

export function calculatePrice(challengeDefinition, commercialConfig) {
  const { step, accountSize, rules } = challengeDefinition ?? {};
  const validation = validateChallengeConfiguration({ step, accountSize, rules, commercial: commercialConfig });
  if (!validation.valid) {
    const error = new Error("Invalid challenge configuration.");
    error.code = "INVALID_CHALLENGE_CONFIGURATION";
    error.details = validation.errors;
    throw error;
  }

  const tables = ADJUSTMENT_TABLES[step];
  const items = {};
  if (step === STEP_TYPES.TWO_STEP) {
    items.phase1ProfitTarget = adjustment(tables.phase1ProfitTarget, "phase1ProfitTarget", rules.phase1ProfitTarget);
    items.phase2ProfitTarget = adjustment(tables.phase2ProfitTarget, "phase2ProfitTarget", rules.phase2ProfitTarget);
  } else {
    items.profitTarget = adjustment(tables.profitTarget, "profitTarget", rules.profitTarget);
  }
  items.dailyLoss = adjustment(tables.dailyLoss, "dailyLoss", rules.dailyLoss);
  items.maxLoss = adjustment(tables.maxLoss, "maxLoss", rules.maxLoss);
  items.minTradingDays = adjustment(tables.minTradingDays, "minTradingDays", rules.minTradingDays);
  items.profitSplit = adjustment(PROFIT_SPLIT_ADJUSTMENTS, "profitSplit", commercialConfig.profitSplit);
  items.payoutFrequency = adjustment(PAYOUT_ADJUSTMENTS, "payoutFrequency", commercialConfig.payoutFrequency);
  items.newsTrading = commercialConfig.newsTrading ? NEWS_TRADING_ADJUSTMENT : 0;
  items.weekendHolding = commercialConfig.weekendHolding ? WEEKEND_HOLDING_ADJUSTMENT : 0;

  const adjustmentTotal = Object.values(items).reduce((sum, value) => sum + value, 0);
  const multiplier = clamp(1 + adjustmentTotal, PRICE_MULTIPLIER_FLOOR, PRICE_MULTIPLIER_CEILING);
  const base = psychological(basePrice(accountSize, step));
  const subtotal = roundCurrency(base * multiplier);

  return {
    currency: "USD",
    basePrice: base,
    adjustmentTotal,
    multiplier,
    subtotal,
    finalPrice: subtotal,
    adjustmentItems: items,
  };
}
