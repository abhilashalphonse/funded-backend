import env from "./env.js";

class UpstashRedisRestClient {
  constructor({
    url = env.UPSTASH_REDIS_REST_URL,
    token = env.UPSTASH_REDIS_REST_TOKEN,
    timeoutMs = env.ACG_SNAPSHOT_REDIS_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.url = url ? String(url).replace(/\/$/, "") : null;
    this.token = token || null;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.lastSuccessAt = null;
    this.lastFailureAt = null;
    this.lastError = null;
  }

  get configured() {
    return Boolean(this.url && this.token);
  }

  health() {
    return {
      configured: this.configured,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastError: this.lastError,
    };
  }

  async command(parts) {
    if (!this.configured) {
      const error = new Error("Upstash Redis is not configured");
      error.code = "REDIS_NOT_CONFIGURED";
      throw error;
    }
    if (typeof this.fetchImpl !== "function") {
      throw new Error("Global fetch is unavailable for Upstash Redis REST client");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(parts),
        signal: controller.signal,
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.error) {
        const error = new Error(payload?.error || `Upstash Redis returned HTTP ${response.status}`);
        error.code = "REDIS_COMMAND_FAILED";
        error.status = response.status;
        throw error;
      }

      this.lastSuccessAt = new Date().toISOString();
      this.lastError = null;
      return payload?.result;
    } catch (error) {
      this.lastFailureAt = new Date().toISOString();
      this.lastError = String(error?.message || error).slice(0, 500);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  ping() {
    return this.command(["PING"]);
  }

  get(key) {
    return this.command(["GET", String(key)]);
  }

  hget(key, field) {
    return this.command(["HGET", String(key), String(field)]);
  }

  set(key, value, ...options) {
    return this.command(["SET", String(key), String(value), ...options.map(value => String(value))]);
  }

  eval(script, keys = [], args = []) {
    return this.command([
      "EVAL",
      String(script),
      String(keys.length),
      ...keys.map(value => String(value)),
      ...args.map(value => String(value)),
    ]);
  }
}

const redis = new UpstashRedisRestClient();

export { UpstashRedisRestClient };
export default redis;
