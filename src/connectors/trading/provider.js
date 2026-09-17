export class TradingProviderConnector {
  constructor(name) {
    if (!name) throw new Error("Trading provider name is required.");
    this.name = String(name);
  }

  async provisionAccount() { throw unsupported(this.name, "provisionAccount"); }
  async getAccount() { throw unsupported(this.name, "getAccount"); }
  async pauseAccount() { throw unsupported(this.name, "pauseAccount"); }
  async resumeAccount() { throw unsupported(this.name, "resumeAccount"); }
  async breachAccount() { throw unsupported(this.name, "breachAccount"); }
  async disableAccount() { throw unsupported(this.name, "disableAccount"); }
  async closeAccount() { throw unsupported(this.name, "closeAccount"); }
  async createTradingSession() { throw unsupported(this.name, "createTradingSession"); }
  async createNativeCredential() { throw unsupported(this.name, "createNativeCredential"); }
}

export function normalizeProviderName(value) {
  const normalized = String(value || "").trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "acg" || normalized === "acgtrader") return "acg-trader";
  if (normalized === "sim" || normalized === "local") return "simulator";
  return normalized;
}

function unsupported(provider, method) {
  const error = new Error(`Trading provider "${provider}" does not support ${method}.`);
  error.code = "TRADING_PROVIDER_OPERATION_UNSUPPORTED";
  error.provider = provider;
  return error;
}
