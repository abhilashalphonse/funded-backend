import { ACGTraderConnector } from "../acg-trader/connector.js";
import { SimulatorConnector } from "../simulator/connector.js";
import { normalizeProviderName } from "./provider.js";

const instances = new Map();

export function configuredTradingProvider() {
  return normalizeProviderName(process.env.TRADING_PROVIDER || "simulator");
}

export function getTradingConnector(provider = configuredTradingProvider()) {
  const name = normalizeProviderName(provider);
  if (!name) throw providerError("Trading provider is required.");
  if (instances.has(name)) return instances.get(name);

  let connector;
  if (name === "simulator") {
    connector = new SimulatorConnector();
  } else if (name === "acg-trader") {
    connector = new ACGTraderConnector({
      baseUrl: process.env.ACG_TRADER_BASE_URL,
      clientId: process.env.ACG_TRADER_CLIENT_ID,
      apiKey: process.env.ACG_TRADER_API_KEY,
      frontendUrl: process.env.ACG_TRADER_FRONTEND_URL,
      timeoutMs: process.env.ACG_TRADER_TIMEOUT_MS || 10000,
    });
  } else {
    throw providerError(`Trading provider "${name}" is not registered.`);
  }

  instances.set(name, connector);
  return connector;
}

export function registerTradingConnector(name, connector) {
  const normalized = normalizeProviderName(name);
  if (!normalized || !connector) throw providerError("Provider name and connector are required.");
  instances.set(normalized, connector);
  return connector;
}

export function clearTradingConnectorRegistry() {
  instances.clear();
}

function providerError(message) {
  const error = new Error(message);
  error.code = "TRADING_PROVIDER_NOT_AVAILABLE";
  return error;
}
