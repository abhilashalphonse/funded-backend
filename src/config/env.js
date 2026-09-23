import "dotenv/config";

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (isProduction && !value) throw new Error(`${name} is required in production.`);
  return value || undefined;
}

function requiredResolved(name, value) {
  const normalized = String(value || "").trim();
  if (isProduction && !normalized) throw new Error(`${name} is required in production.`);
  return normalized || undefined;
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

const runtimeRole = String(process.env.ACG_RUNTIME_ROLE || "all").trim().toLowerCase();
if (!["all", "api", "worker"].includes(runtimeRole)) {
  throw new Error("ACG_RUNTIME_ROLE must be all, api, or worker.");
}

const redisRestUrl = validUrl("UPSTASH_REDIS_REST_URL", String(process.env.UPSTASH_REDIS_REST_URL || "").trim() || undefined);
const redisRestToken = String(process.env.UPSTASH_REDIS_REST_TOKEN || "").trim() || undefined;
if (Boolean(redisRestUrl) !== Boolean(redisRestToken)) {
  throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be configured together.");
}

const rupexBaseUrl = String(process.env.RUPEX_BASE_URL || process.env.UPI_GATEWAY_BASE_URL || "").trim() || undefined;
const rupexApiToken = String(process.env.RUPEX_API_TOKEN || process.env.UPI_GATEWAY_API_TOKEN || "").trim() || undefined;
const rupexCallbackUrl = String(process.env.RUPEX_CALLBACK_URL || process.env.UPI_GATEWAY_CALLBACK_URL || "").trim() || undefined;

const sunpayBaseUrl = String(process.env.SUNPAY_BASE_URL || "").trim() || undefined;
const sunpayApiToken = String(process.env.SUNPAY_API_TOKEN || "").trim() || undefined;
const sunpayCallbackUrl = String(process.env.SUNPAY_CALLBACK_URL || "").trim() || undefined;

const env = Object.freeze({
  NODE_ENV: nodeEnv,
  IS_PRODUCTION: isProduction,
  PORT: positiveInt("PORT", 3000),
  RUNTIME_ROLE: runtimeRole,
  MONGODB_URI: required("MONGODB_URI"),
  POSTGRES_URL: required("POSTGRES_URL"),
  POSTGRES_HOST: process.env.POSTGRES_HOST,
  POSTGRES_PORT: process.env.POSTGRES_PORT,
  POSTGRES_USER: process.env.POSTGRES_USER,
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,
  POSTGRES_DATABASE: process.env.POSTGRES_DATABASE,
  POSTGRES_POOL_MAX: positiveInt("POSTGRES_POOL_MAX", 4),
  POSTGRES_CONNECTION_TIMEOUT_MS: positiveInt("POSTGRES_CONNECTION_TIMEOUT_MS", 30000),

  PG_BOSS_RETENTION_ENABLED: bool("PG_BOSS_RETENTION_ENABLED", true),
  PG_BOSS_RETENTION_INTERVAL_MS: positiveInt("PG_BOSS_RETENTION_INTERVAL_MS", 21600000),
  PG_BOSS_RETENTION_INITIAL_DELAY_MS: positiveInt("PG_BOSS_RETENTION_INITIAL_DELAY_MS", 300000),
  PG_BOSS_RETENTION_BATCH_SIZE: positiveInt("PG_BOSS_RETENTION_BATCH_SIZE", 500),
  PG_BOSS_RETENTION_MAX_BATCHES: positiveInt("PG_BOSS_RETENTION_MAX_BATCHES", 5),
  PG_BOSS_RETENTION_LOCK_TIMEOUT_MS: positiveInt("PG_BOSS_RETENTION_LOCK_TIMEOUT_MS", 1000),
  PG_BOSS_RETENTION_STATEMENT_TIMEOUT_MS: positiveInt("PG_BOSS_RETENTION_STATEMENT_TIMEOUT_MS", 5000),

  UPSTASH_REDIS_REST_URL: redisRestUrl,
  UPSTASH_REDIS_REST_TOKEN: redisRestToken,
  ACG_SNAPSHOT_REDIS_TIMEOUT_MS: positiveInt("ACG_SNAPSHOT_REDIS_TIMEOUT_MS", 1500),
  ACG_SNAPSHOT_CACHE_TTL_SECONDS: positiveInt("ACG_SNAPSHOT_CACHE_TTL_SECONDS", 900),
  ACG_SNAPSHOT_BINDING_TTL_SECONDS: positiveInt("ACG_SNAPSHOT_BINDING_TTL_SECONDS", 3600),
  ACG_SNAPSHOT_PROJECTION_CONCURRENCY: positiveInt("ACG_SNAPSHOT_PROJECTION_CONCURRENCY", 32),
  ACG_SNAPSHOT_PROJECTION_LOCK_MS: positiveInt("ACG_SNAPSHOT_PROJECTION_LOCK_MS", 10000),

  CORS_ORIGINS: csv("CORS_ORIGINS", "http://localhost:5173"),
  ADMIN_EMAILS: csv("ADMIN_EMAILS").map(value => value.toLowerCase()),
  FRONTEND_URL: validUrl("FRONTEND_URL", required("FRONTEND_URL")),
  SUPABASE_URL: validUrl("SUPABASE_URL", required("SUPABASE_URL")),
  SUPABASE_ANON_KEY: required("SUPABASE_ANON_KEY"),

  // AI support. Optional so deployments remain healthy while the key is being provisioned;
  // the support service fails closed to human escalation when it is absent.
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_SUPPORT_MODEL: String(process.env.OPENAI_SUPPORT_MODEL || "gpt-5.6-luna").trim(),
  OPENAI_SUPPORT_TIMEOUT_MS: positiveInt("OPENAI_SUPPORT_TIMEOUT_MS", 12000),

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

  // Rupex is the currently integrated UPI gateway. Legacy UPI_GATEWAY_* names
  // remain accepted during deployment migration, but new configuration should use RUPEX_*.
  RUPEX_BASE_URL: validUrl("RUPEX_BASE_URL", isProduction ? requiredResolved("RUPEX_BASE_URL", rupexBaseUrl) : rupexBaseUrl),
  RUPEX_API_TOKEN: isProduction ? requiredResolved("RUPEX_API_TOKEN", rupexApiToken) : rupexApiToken,
  RUPEX_CALLBACK_URL: validUrl("RUPEX_CALLBACK_URL", isProduction ? requiredResolved("RUPEX_CALLBACK_URL", rupexCallbackUrl) : rupexCallbackUrl),

  // Sunpay is registered in the gateway selector but remains optional until its adapter is integrated.
  SUNPAY_BASE_URL: validUrl("SUNPAY_BASE_URL", sunpayBaseUrl),
  SUNPAY_API_TOKEN: sunpayApiToken,
  SUNPAY_CALLBACK_URL: validUrl("SUNPAY_CALLBACK_URL", sunpayCallbackUrl),

  ENABLE_SIMULATOR_ROUTES: bool("ENABLE_SIMULATOR_ROUTES", !isProduction),
  ENABLE_LOCAL_ADMIN_ROUTES: bool("ENABLE_LOCAL_ADMIN_ROUTES", !isProduction),
});

if (isProduction && env.CORS_ORIGINS.length === 0) throw new Error("CORS_ORIGINS must include the production frontend origin.");
if (env.ACG_TRADER_WEBHOOK_SECRET && env.ACG_TRADER_WEBHOOK_SECRET.length < 16) throw new Error("ACG_TRADER_WEBHOOK_SECRET must be at least 16 characters.");

export default env;
