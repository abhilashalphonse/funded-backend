import "dotenv/config";

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (isProduction && !value) throw new Error(`${name} is required in production.`);
  return value || undefined;
}

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean.`);
}

function csv(name, fallback = "") {
  return String(process.env[name] ?? fallback).split(",").map(value => value.trim()).filter(Boolean);
}

function validUrl(name, value) {
  if (!value) return value;
  try { new URL(value); return value; }
  catch { throw new Error(`${name} must be a valid URL.`); }
}

const tradingProvider = String(process.env.TRADING_PROVIDER || (isProduction ? "acg-trader" : "simulator")).trim().toLowerCase();
if (!["acg-trader", "simulator"].includes(tradingProvider)) throw new Error("TRADING_PROVIDER must be acg-trader or simulator.");
if (isProduction && tradingProvider !== "acg-trader") throw new Error("Production TRADING_PROVIDER must be acg-trader.");

const env = Object.freeze({
  NODE_ENV: nodeEnv,
  IS_PRODUCTION: isProduction,
  PORT: positiveInt("PORT", 3000),
  MONGODB_URI: required("MONGODB_URI"),
  POSTGRES_URL: required("POSTGRES_URL"),
  POSTGRES_HOST: process.env.POSTGRES_HOST,
  POSTGRES_PORT: process.env.POSTGRES_PORT,
  POSTGRES_USER: process.env.POSTGRES_USER,
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,
  POSTGRES_DATABASE: process.env.POSTGRES_DATABASE,
  POSTGRES_POOL_MAX: positiveInt("POSTGRES_POOL_MAX", 4),
  POSTGRES_CONNECTION_TIMEOUT_MS: positiveInt("POSTGRES_CONNECTION_TIMEOUT_MS", 30000),

  CORS_ORIGINS: csv("CORS_ORIGINS", "http://localhost:5173"),
  FRONTEND_URL: validUrl("FRONTEND_URL", required("FRONTEND_URL")),
  SUPABASE_URL: validUrl("SUPABASE_URL", required("SUPABASE_URL")),
  SUPABASE_ANON_KEY: required("SUPABASE_ANON_KEY"),

  TRADING_PROVIDER: tradingProvider,
  ACG_TRADER_BASE_URL: validUrl("ACG_TRADER_BASE_URL", tradingProvider === "acg-trader" ? required("ACG_TRADER_BASE_URL") : process.env.ACG_TRADER_BASE_URL),
  ACG_TRADER_CLIENT_ID: tradingProvider === "acg-trader" ? required("ACG_TRADER_CLIENT_ID") : process.env.ACG_TRADER_CLIENT_ID,
  ACG_TRADER_API_KEY: tradingProvider === "acg-trader" ? required("ACG_TRADER_API_KEY") : process.env.ACG_TRADER_API_KEY,
  ACG_TRADER_FRONTEND_URL: validUrl("ACG_TRADER_FRONTEND_URL", tradingProvider === "acg-trader" ? required("ACG_TRADER_FRONTEND_URL") : process.env.ACG_TRADER_FRONTEND_URL),
  ACG_TRADER_TIMEOUT_MS: positiveInt("ACG_TRADER_TIMEOUT_MS", 10000),
  ACG_TRADER_WEBHOOK_SECRET: isProduction ? required("ACG_TRADER_WEBHOOK_SECRET") : process.env.ACG_TRADER_WEBHOOK_SECRET,

  NOWPAYMENTS_API_KEY: isProduction ? required("NOWPAYMENTS_API_KEY") : process.env.NOWPAYMENTS_API_KEY,
  NOWPAYMENTS_IPN_URL: validUrl("NOWPAYMENTS_IPN_URL", isProduction ? required("NOWPAYMENTS_IPN_URL") : process.env.NOWPAYMENTS_IPN_URL),
  NOWPAYMENTS_IPN_SECRET: isProduction ? required("NOWPAYMENTS_IPN_SECRET") : process.env.NOWPAYMENTS_IPN_SECRET,

  ENABLE_SIMULATOR_ROUTES: bool("ENABLE_SIMULATOR_ROUTES", !isProduction),
  ENABLE_LOCAL_ADMIN_ROUTES: bool("ENABLE_LOCAL_ADMIN_ROUTES", !isProduction),
});

if (isProduction && env.CORS_ORIGINS.length === 0) throw new Error("CORS_ORIGINS must include the production frontend origin.");
if (env.ACG_TRADER_WEBHOOK_SECRET && env.ACG_TRADER_WEBHOOK_SECRET.length < 16) throw new Error("ACG_TRADER_WEBHOOK_SECRET must be at least 16 characters.");

export default env;
