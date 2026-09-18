import env from "../../config/env.js";
import { ACGTraderClient } from "../../connectors/acg-trader/client.js";

function configuredClient() {
  return new ACGTraderClient({
    baseUrl: env.ACG_TRADER_BASE_URL,
    clientId: env.ACG_TRADER_CLIENT_ID,
    apiKey: env.ACG_TRADER_API_KEY,
    timeoutMs: env.ACG_TRADER_TIMEOUT_MS,
  });
}

export async function getTradingReadiness() {
  const checks = {
    providerConfigured: env.TRADING_PROVIDER === "acg-trader",
    traderBaseUrlConfigured: Boolean(env.ACG_TRADER_BASE_URL),
    traderFrontendConfigured: Boolean(env.ACG_TRADER_FRONTEND_URL),
    serviceClientConfigured: Boolean(env.ACG_TRADER_CLIENT_ID && env.ACG_TRADER_API_KEY),
    fundedWebhookConfigured: Boolean(env.ACG_TRADER_WEBHOOK_SECRET),
    traderReachable: false,
    traderReady: false,
    servicePrincipalAuthenticated: false,
    tradingRuntimeReady: false,
    marketLive: false,
    platformEventsReady: false,
  };

  const details = { publicHealth: null, operationsHealth: null };
  let error = null;

  if (!checks.providerConfigured || !checks.traderBaseUrlConfigured || !checks.serviceClientConfigured) {
    return { ready: false, checks, details, error: "ACG Trader integration is not fully configured on ACG Funded." };
  }

  const client = configuredClient();

  try {
    const publicHealth = await client.healthReady();
    details.publicHealth = publicHealth;
    checks.traderReachable = true;
    checks.traderReady = publicHealth?.status === "ready";
    checks.tradingRuntimeReady =
      publicHealth?.trading?.enabled === true &&
      publicHealth?.checks?.tradingRuntimeReady === true;
    checks.marketLive =
      publicHealth?.market?.enabled === true &&
      publicHealth?.market?.state === "LIVE";
    const relay = publicHealth?.trading?.platformEvents;
    checks.platformEventsReady =
      relay?.enabled === true &&
      relay?.started === true &&
      relay?.webhookConfigured === true;
  } catch (err) {
    error = err?.message || "Unable to reach ACG Trader.";
  }

  if (checks.traderReachable) {
    try {
      const operationsHealth = await client.operationsHealth();
      details.operationsHealth = operationsHealth;
      checks.servicePrincipalAuthenticated = true;
      if (operationsHealth?.trading?.state && operationsHealth.trading.state !== "READY") {
        checks.tradingRuntimeReady = false;
      }
      const relay = operationsHealth?.trading?.platformEvents;
      if (relay) {
        checks.platformEventsReady =
          relay.enabled === true &&
          relay.started === true &&
          relay.webhookConfigured === true;
      }
    } catch (err) {
      error = err?.message || "ACG Funded service principal could not authenticate with ACG Trader.";
    }
  }

  const ready = Object.values(checks).every(Boolean);
  return { ready, checks, details, error: ready ? null : error || "ACG Trader is not ready for free-trial provisioning." };
}

export async function requireTradingReadiness() {
  const readiness = await getTradingReadiness();
  if (!readiness.ready) {
    const error = new Error(readiness.error || "ACG Trader is not ready.");
    error.status = 503;
    error.code = "ACG_TRADER_NOT_READY";
    error.details = readiness;
    throw error;
  }
  return readiness;
}
