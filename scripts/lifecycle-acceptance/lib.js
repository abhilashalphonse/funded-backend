import fs from "node:fs/promises";
import path from "node:path";

export class AcceptanceHttpError extends Error {
  constructor(message, { status = 0, body = null, method = null, url = null } = {}) {
    super(message);
    this.name = "AcceptanceHttpError";
    this.status = status;
    this.body = body;
    this.method = method;
    this.url = url;
  }
}

export function envFlag(value) {
  return ["1", "true", "yes", "y", "on", "YES_I_UNDERSTAND"].includes(String(value || "").trim());
}

export function required(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(name + " is required");
  return text;
}

export function commaList(value) {
  return String(value || "").split(",").map(item => item.trim()).filter(Boolean);
}

function stripTrailingSlash(value) {
  let text = String(value || "").trim();
  while (text.endsWith("/")) text = text.slice(0, -1);
  return text;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function loadAcceptanceConfig(env = process.env, argv = process.argv.slice(2)) {
  const dryRun = argv.includes("--dry-run");
  const requireAll = !argv.includes("--allow-skip") && !envFlag(env.ACCEPTANCE_ALLOW_SKIP);
  const fundedBaseUrl = stripTrailingSlash(env.ACCEPTANCE_FUNDED_BASE_URL || "https://funded-backend-production.up.railway.app");
  const traderBaseUrl = stripTrailingSlash(env.ACCEPTANCE_TRADER_BASE_URL || env.ACG_TRADER_BASE_URL || "");
  const challengeAId = String(env.ACCEPTANCE_CHALLENGE_A_ID || "").trim();
  const challengeBId = String(env.ACCEPTANCE_CHALLENGE_B_ID || "").trim();
  const confirmedIds = commaList(env.ACCEPTANCE_CONFIRM_ACCOUNT_IDS);

  return {
    dryRun,
    requireAll,
    destructiveAllowed: envFlag(env.ACCEPTANCE_ALLOW_DESTRUCTIVE),
    allowNonTestIdentity: envFlag(env.ACCEPTANCE_ALLOW_NON_TEST_IDENTITY),
    cleanupExistingTrial: envFlag(env.ACCEPTANCE_CLEANUP_EXISTING_TRIAL),
    fundedBaseUrl,
    traderBaseUrl,
    customerBearer: String(env.ACCEPTANCE_CUSTOMER_BEARER || "").trim(),
    adminBearer: String(env.ACCEPTANCE_ADMIN_BEARER || "").trim(),
    traderServiceKey: String(env.ACCEPTANCE_TRADER_SERVICE_KEY || env.ACG_TRADER_API_KEY || "").trim(),
    traderClientId: String(env.ACCEPTANCE_TRADER_CLIENT_ID || env.ACG_TRADER_CLIENT_ID || "acg-funded-backend").trim(),
    customerId: String(env.ACCEPTANCE_CUSTOMER_ID || "").trim(),
    challengeAId,
    challengeBId,
    confirmedIds,
    identityPattern: String(env.ACCEPTANCE_TEST_EMAIL_PATTERN || "acceptance").trim(),
    symbol: String(env.ACCEPTANCE_SYMBOL || "EURUSD").trim().toUpperCase(),
    volume: String(env.ACCEPTANCE_VOLUME || "0.01").trim(),
    trialSize: Number(env.ACCEPTANCE_TRIAL_SIZE || 10000),
    trialTargetPercent: Number(env.ACCEPTANCE_TRIAL_TARGET_PERCENT || 1),
    targetBuffer: Number(env.ACCEPTANCE_TARGET_BUFFER || 5),
    timeoutMs: Number(env.ACCEPTANCE_TIMEOUT_MS || 90000),
    pollMs: Number(env.ACCEPTANCE_POLL_MS || 250),
    raceBreachDelayMs: Number(env.ACCEPTANCE_RACE_BREACH_DELAY_MS || 4500),
    restartHookUrl: String(env.ACCEPTANCE_RESTART_HOOK_URL || "").trim(),
    restartHookBearer: String(env.ACCEPTANCE_RESTART_HOOK_BEARER || "").trim(),
    reportDir: String(env.ACCEPTANCE_REPORT_DIR || "artifacts").trim(),
  };
}

export function validateAcceptanceConfig(config) {
  const errors = [];
  if (!isHttpUrl(config.fundedBaseUrl)) errors.push("ACCEPTANCE_FUNDED_BASE_URL must be an http(s) URL.");
  if (!isHttpUrl(config.traderBaseUrl)) errors.push("ACCEPTANCE_TRADER_BASE_URL or ACG_TRADER_BASE_URL is required.");
  if (!config.customerId) errors.push("ACCEPTANCE_CUSTOMER_ID is required.");
  if (!config.customerBearer) errors.push("ACCEPTANCE_CUSTOMER_BEARER is required.");
  if (!config.adminBearer) errors.push("ACCEPTANCE_ADMIN_BEARER is required.");
  if (!config.traderServiceKey) errors.push("ACCEPTANCE_TRADER_SERVICE_KEY or ACG_TRADER_API_KEY is required.");
  if (!config.challengeAId) errors.push("ACCEPTANCE_CHALLENGE_A_ID is required.");
  if (!config.challengeBId) errors.push("ACCEPTANCE_CHALLENGE_B_ID is required.");
  if (config.challengeAId && config.challengeBId && config.challengeAId === config.challengeBId) errors.push("Challenge A and B must be different accounts.");
  if (!(config.trialSize > 0)) errors.push("ACCEPTANCE_TRIAL_SIZE must be greater than zero.");
  if (!(config.trialTargetPercent > 0)) errors.push("ACCEPTANCE_TRIAL_TARGET_PERCENT must be greater than zero.");
  if (!(Number(config.volume) > 0)) errors.push("ACCEPTANCE_VOLUME must be greater than zero.");

  const expected = [config.challengeAId, config.challengeBId].filter(Boolean).sort();
  const confirmed = [...config.confirmedIds].sort();
  if (expected.length === 2 && JSON.stringify(expected) !== JSON.stringify(confirmed)) {
    errors.push("ACCEPTANCE_CONFIRM_ACCOUNT_IDS must contain exactly Challenge A and Challenge B IDs.");
  }
  if (!config.dryRun && !config.destructiveAllowed) {
    errors.push("Set ACCEPTANCE_ALLOW_DESTRUCTIVE=YES_I_UNDERSTAND for a mutating run.");
  }
  if (errors.length) {
    const error = new Error("Acceptance configuration is invalid:\n- " + errors.join("\n- "));
    error.code = "ACCEPTANCE_CONFIG_INVALID";
    throw error;
  }
  return config;
}

export async function httpJson(baseUrl, pathname, {
  method = "GET",
  bearer = null,
  headers = {},
  body = undefined,
  expected = null,
  timeoutMs = 15000,
} = {}) {
  const url = new URL(pathname, baseUrl).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(bearer ? { authorization: "Bearer " + bearer } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const textBody = await response.text();
    let payload = null;
    try { payload = textBody ? JSON.parse(textBody) : null; } catch { payload = textBody || null; }
    if (expected && ![].concat(expected).includes(response.status)) {
      throw new AcceptanceHttpError(method + " " + pathname + " returned HTTP " + response.status, {
        status: response.status,
        body: payload,
        method,
        url,
      });
    }
    return { status: response.status, ok: response.ok, body: payload, headers: response.headers };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AcceptanceHttpError(method + " " + pathname + " timed out", { method, url });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function poll(fn, predicate, {
  timeoutMs = 90000,
  intervalMs = 250,
  description = "condition",
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (await predicate(last)) return last;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const error = new Error("Timed out waiting for " + description);
  error.code = "ACCEPTANCE_POLL_TIMEOUT";
  error.lastValue = last;
  error.cause = lastError;
  throw error;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function extractFederationTicket(launchUrl) {
  const url = new URL(launchUrl);
  const ticket = url.searchParams.get("ticket");
  if (!ticket) throw new Error("Trading launch URL did not contain a federation ticket.");
  return ticket;
}

export function assertAcceptanceIdentity(email, pattern = "acceptance", allowOverride = false) {
  if (allowOverride) return true;
  const value = String(email || "").trim();
  if (!value) throw new Error("Acceptance customer does not have an email identity.");
  let matches = false;
  try { matches = new RegExp(pattern, "i").test(value); } catch { matches = value.toLowerCase().includes(String(pattern).toLowerCase()); }
  if (!matches) {
    const error = new Error("Refusing destructive lifecycle tests for non-acceptance identity: " + value);
    error.code = "ACCEPTANCE_IDENTITY_GUARD";
    throw error;
  }
  return true;
}

export function currentPlatformRecord(account) {
  const platformId = String(account?.platformAccountId || "");
  return (account?.platformAccounts || []).find(item => String(item?.platformAccountId || "") === platformId) || null;
}

export function phaseTarget(account, phase = account?.currentPhase || 1) {
  const initial = Number(account?.initialDeposit || account?.accountSize || 0);
  const rule = (account?.rules?.phases || []).find(item => Number(item?.phase) === Number(phase));
  const percent = Number(rule?.profitTarget);
  if (!(initial > 0) || !Number.isFinite(percent)) throw new Error("Account is missing a valid phase target.");
  return {
    initial,
    percent,
    targetBalance: initial + (initial * percent / 100),
  };
}

export function adjustmentToTarget(account, buffer = 5) {
  const target = phaseTarget(account);
  const balance = Number(account?.balance);
  if (!Number.isFinite(balance)) throw new Error("Funded account balance is not numeric.");
  return Math.max(0.01, target.targetBalance - balance + Math.max(0, Number(buffer) || 0));
}

export function activePlatformAccounts(account, { accountType = null } = {}) {
  return (account?.platformAccounts || []).filter(item => {
    if (String(item?.status || "").toUpperCase() !== "ACTIVE") return false;
    if (accountType && String(item?.accountType || "").toUpperCase() !== String(accountType).toUpperCase()) return false;
    return true;
  });
}

export class AcceptanceReport {
  constructor({ runId, startedAt = new Date().toISOString(), config = {} }) {
    this.runId = runId;
    this.startedAt = startedAt;
    this.finishedAt = null;
    this.config = config;
    this.scenarios = [];
    this.evidence = {};
  }

  async run(name, fn) {
    const startedAt = new Date().toISOString();
    try {
      const details = await fn();
      const status = details?.status === "SKIP" ? "SKIP" : "PASS";
      this.scenarios.push({ name, status, startedAt, finishedAt: new Date().toISOString(), details: details || null });
      return details;
    } catch (error) {
      this.scenarios.push({
        name,
        status: "FAIL",
        startedAt,
        finishedAt: new Date().toISOString(),
        error: serializeError(error),
      });
      return null;
    }
  }

  finish({ requireAll = true } = {}) {
    this.finishedAt = new Date().toISOString();
    const failed = this.scenarios.filter(item => item.status === "FAIL");
    const skipped = this.scenarios.filter(item => item.status === "SKIP");
    this.status = failed.length || (requireAll && skipped.length) ? "FAIL" : "PASS";
    this.summary = {
      pass: this.scenarios.filter(item => item.status === "PASS").length,
      fail: failed.length,
      skip: skipped.length,
      total: this.scenarios.length,
    };
    return this;
  }

  toMarkdown() {
    const rows = this.scenarios.map((item, index) =>
      "| " + (index + 1) + " | " + escapeMd(item.name) + " | " + item.status + " | " + escapeMd(item.error?.message || item.details?.summary || "") + " |"
    );
    return [
      "# ACG Lifecycle Acceptance Report",
      "",
      "Run: " + this.runId,
      "Status: **" + (this.status || "RUNNING") + "**",
      "Started: " + this.startedAt,
      "Finished: " + (this.finishedAt || "-"),
      "",
      "| # | Scenario | Result | Note |",
      "|---:|---|---|---|",
      ...rows,
      "",
      "## Evidence",
      "",
      "    " + JSON.stringify(this.evidence, null, 2).replace(/\n/g, "\n    "),
      "",
    ].join("\n");
  }

  async write(reportDir) {
    await fs.mkdir(reportDir, { recursive: true });
    const jsonPath = path.join(reportDir, "lifecycle-acceptance-" + this.runId + ".json");
    const mdPath = path.join(reportDir, "lifecycle-acceptance-" + this.runId + ".md");
    await fs.writeFile(jsonPath, JSON.stringify(this, null, 2));
    await fs.writeFile(mdPath, this.toMarkdown());
    return { jsonPath, mdPath };
  }
}

export function serializeError(error) {
  return {
    name: error?.name || "Error",
    code: error?.code || error?.body?.code || null,
    status: Number(error?.status) || null,
    message: String(error?.message || error),
    body: error?.body ?? null,
  };
}

function escapeMd(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
