export class ACGTraderClient {
  constructor({ baseUrl, clientId, apiKey, timeoutMs = 10000, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.clientId = String(clientId || "").trim();
    this.apiKey = String(apiKey || "").trim();
    this.timeoutMs = Number(timeoutMs) || 10000;
    this.fetch = fetchImpl;

    if (!this.baseUrl) throw configurationError("ACG_TRADER_BASE_URL is required.");
    if (!this.clientId) throw configurationError("ACG_TRADER_CLIENT_ID is required.");
    if (!this.apiKey) throw configurationError("ACG_TRADER_API_KEY is required.");
    if (typeof this.fetch !== "function") throw configurationError("A fetch implementation is required.");
  }

  provisionAccount(command) { return this.request("/v1/internal/trading/accounts/provision", { method: "POST", body: command }); }
  getAccount(accountId) { return this.request(`/v1/internal/trading/accounts/${encodeURIComponent(accountId)}`); }
  getAdminObservability(accountId, { limit = 100 } = {}) { return this.request(`/v1/internal/trading/accounts/${encodeURIComponent(accountId)}/admin-observability?limit=${Math.max(1, Math.min(200, Number(limit) || 100))}`); }
  pauseAccount(accountId, options = {}) { return this.request(`/v1/internal/trading/accounts/${encodeURIComponent(accountId)}/pause`, { method: "POST", body: options }); }
  stageAccount(accountId, options = {}) { return this.request(`/v1/internal/trading/accounts/${encodeURIComponent(accountId)}/stage`, { method: "POST", body: options }); }
  activateAccount(accountId, options = {}) { return this.request(`/v1/internal/trading/accounts/${encodeURIComponent(accountId)}/activate`, { method: "POST", body: options }); }
  resumeAccount(accountId, options = {}) { return this.request(`/v1/internal/trading/accounts/${encodeURIComponent(accountId)}/resume`, { method: "POST", body: options }); }
  breachAccount(accountId, options = {}) { return this.request(`/v1/internal/trading/accounts/${encodeURIComponent(accountId)}/breach`, { method: "POST", body: options }); }
  flattenAccount(accountId, options = {}) { return this.request(`/v1/internal/trading/accounts/${encodeURIComponent(accountId)}/flatten`, { method: "POST", body: options }); }
  disableAccount(accountId, options = {}) { return this.request(`/v1/internal/trading/accounts/${encodeURIComponent(accountId)}/disable`, { method: "POST", body: options }); }
  closeAccount(accountId, options = {}) { return this.request(`/v1/internal/trading/accounts/${encodeURIComponent(accountId)}/close`, { method: "POST", body: options }); }
  createFederationTicket(command) { return this.requestWithTransientRetry("/v1/internal/auth/federation/tickets", { method: "POST", body: command }); }
  createNativeCredential(accountId, command = {}) { return this.request(`/v1/internal/auth/accounts/${encodeURIComponent(accountId)}/credentials`, { method: "POST", body: command }); }
  operationsHealth() { return this.request("/v1/internal/operations/health"); }
  healthReady() { return this.publicRequest("/health/ready"); }

  async requestWithTransientRetry(path, options = {}) {
    try {
      return await this.request(path, options);
    } catch (error) {
      if (!isTransientProviderError(error)) throw error;
      await delay(250);
      return this.request(path, options);
    }
  }

  async publicRequest(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, { signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw responseError(response, payload);
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeout = new Error(`ACG Trader request timed out after ${this.timeoutMs}ms.`);
        timeout.code = "TRADING_PROVIDER_TIMEOUT";
        timeout.provider = "acg-trader";
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async request(path, { method = "GET", body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "X-ACG-Client-Id": this.clientId,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw responseError(response, payload);
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeout = new Error(`ACG Trader request timed out after ${this.timeoutMs}ms.`);
        timeout.code = "TRADING_PROVIDER_TIMEOUT";
        timeout.provider = "acg-trader";
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function configurationError(message) {
  const error = new Error(message);
  error.code = "TRADING_PROVIDER_CONFIGURATION_ERROR";
  error.provider = "acg-trader";
  return error;
}

function responseError(response, payload) {
  const remote = payload?.error || {};
  const error = new Error(remote.message || `ACG Trader request failed (${response.status}).`);
  error.status = response.status;
  error.code = remote.code || "TRADING_PROVIDER_REQUEST_FAILED";
  error.details = remote.details;
  error.requestId = remote.requestId;
  error.provider = "acg-trader";
  return error;
}


function isTransientProviderError(error) {
  if (!error) return false;
  if ([502, 503, 504].includes(Number(error.status))) return true;
  return ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EAI_AGAIN"].includes(error.code)
    || error instanceof TypeError;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
