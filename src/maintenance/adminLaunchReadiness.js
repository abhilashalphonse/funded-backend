import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import env from "../config/env.js";
import Account from "../accounts/account.model.js";
import Customer from "../customers/customer.model.js";
import AcceptanceRun from "../models/acceptanceRun.model.js";
import {
  ACG_FUNDED_RISK_POLICY_V2_VERSION,
  activateTradingAccount,
  provisionTradingAccount,
  resolveProvisioningRiskPolicyVersion,
} from "../connectors/trading/account-provisioning.js";
import { getTradingConnector } from "../connectors/trading/registry.js";
import { ensureDemoAccount } from "../apis/services/customer.service.js";
import { createCustomerTradingLaunch } from "../apis/services/tradingLaunch.service.js";

const ACCOUNT_SIZE = 10000;
const PHASE_TARGET_PERCENT = 1;
const DEFAULT_SYMBOL = "BTCUSD";
const DEFAULT_VOLUME = "0.01";
const RUN_CONFIRMATION = "RUN ACCEPTANCE";
const RUN_TIMEOUT_MS = 90000;
const POLL_MS = 250;
const BREACH_RACE_DELAY_MS = 4500;

function errorDetails(error) {
  return {
    name: error?.name || "Error",
    code: error?.code || error?.body?.code || null,
    status: Number(error?.status) || null,
    message: String(error?.message || error),
    body: error?.body ?? null,
  };
}

function acceptanceError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function shortId() {
  return randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
}

function runId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `ACC-${stamp}-${shortId().slice(0, 6)}`;
}

function syntheticCustomerId(id) {
  return `CUS-${String(id).replace(/[^A-Z0-9]/gi, "").slice(-20).toUpperCase()}`;
}

function customerContext(customer) {
  return {
    id: String(customer.customerId),
    customerId: String(customer.customerId),
    customerIds: [String(customer.customerId)],
    email: String(customer.primaryEmail || "").toLowerCase(),
    status: String(customer.status || "ACTIVE"),
    metadata: { acceptanceFixture: true },
  };
}

function normalizeSymbol(value) {
  const symbol = String(value || DEFAULT_SYMBOL).trim().toUpperCase().replace("/", "");
  if (!/^[A-Z0-9]{3,16}$/.test(symbol)) {
    throw acceptanceError("Acceptance symbol is invalid.", "ACCEPTANCE_SYMBOL_INVALID");
  }
  return symbol;
}

function normalizeVolume(value) {
  const number = Number(value ?? DEFAULT_VOLUME);
  if (!Number.isFinite(number) || number <= 0) {
    throw acceptanceError("Acceptance volume must be greater than zero.", "ACCEPTANCE_VOLUME_INVALID");
  }
  return String(value ?? DEFAULT_VOLUME);
}

export function validateAcceptanceConfirmation({ confirmation, reason } = {}) {
  if (String(confirmation || "").trim() !== RUN_CONFIRMATION) {
    throw acceptanceError(
      `Type exactly "${RUN_CONFIRMATION}" to authorize the destructive acceptance run.`,
      "ACCEPTANCE_CONFIRMATION_REQUIRED",
      409,
    );
  }
  if (String(reason || "").trim().length < 5) {
    throw acceptanceError("A reason of at least 5 characters is required.", "ACCEPTANCE_REASON_REQUIRED");
  }
  return true;
}

export function acceptanceChallengeSpec({ accountId, customerId, accountSize = ACCOUNT_SIZE } = {}) {
  return {
    accountId,
    ownerExternalRef: customerId,
    customerId,
    accountMode: "CHALLENGE",
    challengeType: "TWO_STEP",
    accountSize,
    initialDeposit: accountSize,
    currentPhase: 1,
    commercialTerms: {
      profitSplit: 80,
      payoutFrequency: "Biweekly",
      newsTrading: false,
      weekendHolding: false,
    },
    rules: {
      dailyDrawdown: 5,
      maxDrawdown: 10,
      minimumTradingDays: 0,
      phases: [
        { phase: 1, profitTarget: PHASE_TARGET_PERCENT },
        { phase: 2, profitTarget: PHASE_TARGET_PERCENT },
      ],
    },
    leverage: 100,
    platform: "acg-trader",
    status: "NEW",
    enabled: false,
    balance: accountSize,
    equity: accountSize,
    dailyStartEquity: accountSize,
    marginFree: accountSize,
    projections: {
      highestBalance: accountSize,
      highestEquity: accountSize,
      profit: 0,
      dailyLoss: 0,
      totalLoss: 0,
      dailyStartBalance: accountSize,
      tradingDays: 0,
    },
  };
}

async function createChallengeFixture({ customerId, label, id }) {
  const accountId = `ACG-ACC-${id.replace(/[^A-Z0-9]/gi, "").slice(-12).toUpperCase()}-${label}`;
  let account = await Account.create(acceptanceChallengeSpec({ accountId, customerId }));

  await provisionTradingAccount(account, {
    phase: 1,
    accountType: "CHALLENGE",
    activate: false,
    riskPolicyVersion: ACG_FUNDED_RISK_POLICY_V2_VERSION,
  });

  account.status = "ACTIVE";
  account.enabled = false;
  await account.save();

  await activateTradingAccount(account, {
    platformAccountId: account.platformAccountId,
    reason: "ACG_ACCEPTANCE_FIXTURE_ACTIVATED",
  });

  const record = (account.platformAccounts || []).find(item =>
    String(item.platformAccountId || "") === String(account.platformAccountId || "")
  );
  if (record) record.status = "ACTIVE";
  account.enabled = true;
  await account.save();
  return account;
}

async function closeFixtureAccounts(run, reason) {
  const ids = [
    run?.fixture?.challengeAId,
    run?.fixture?.challengeBId,
    run?.fixture?.trialAccountId,
  ].filter(Boolean);
  const accounts = await Account.find({ accountId: { $in: ids } });
  const connector = getTradingConnector("acg-trader");
  const errors = [];

  for (const account of accounts) {
    for (const platform of account.platformAccounts || []) {
      const status = String(platform.status || "").toUpperCase();
      if (!["ACTIVE", "PAUSED"].includes(status)) continue;
      try {
        await connector.closeAccount({
          externalRef: platform.externalRef || account.accountId,
          platformAccountId: platform.platformAccountId,
          reason: `ACG_ACCEPTANCE_CLEANUP: ${reason}`,
          liquidate: true,
        });
        platform.status = "CLOSED";
      } catch (error) {
        errors.push({
          accountId: account.accountId,
          platformAccountId: platform.platformAccountId,
          message: String(error?.message || error),
        });
      }
    }

    if (account.accountMode === "DEMO") account.activeTrialKey = null;
    account.enabled = false;
    if (!["BREACHED", "PASSED", "EXPIRED", "CLOSED"].includes(String(account.status || "").toUpperCase())) {
      account.status = "CLOSED";
    }
    await account.save().catch(error => {
      errors.push({ accountId: account.accountId, message: String(error?.message || error) });
    });
  }

  return errors;
}

export async function createAcceptanceFixture({
  createdBy,
  symbol = DEFAULT_SYMBOL,
  volume = DEFAULT_VOLUME,
} = {}) {
  if (resolveProvisioningRiskPolicyVersion() !== ACG_FUNDED_RISK_POLICY_V2_VERSION) {
    throw acceptanceError(
      "Launch-readiness fixtures require ACG_FUNDED_V2 provisioning.",
      "ACCEPTANCE_REQUIRES_V2",
      409,
    );
  }

  const id = runId();
  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedVolume = normalizeVolume(volume);
  const customerId = syntheticCustomerId(id);
  const email = `acceptance+${id.toLowerCase()}@acgfunded.test`;

  const run = await AcceptanceRun.create({
    runId: id,
    status: "CREATING",
    createdBy: String(createdBy || "unknown"),
    symbol: normalizedSymbol,
    volume: normalizedVolume,
    fixture: { customerId, email },
  });

  try {
    await Customer.create({
      customerId,
      primaryEmail: email,
      status: "ACTIVE",
    });

    const challengeA = await createChallengeFixture({ customerId, label: "A", id });
    run.fixture = {
      ...run.fixture,
      challengeAId: challengeA.accountId,
      challengeAPlatformAccountId: challengeA.platformAccountId,
    };
    await run.save();

    const challengeB = await createChallengeFixture({ customerId, label: "B", id });
    run.fixture = {
      ...run.fixture,
      challengeBId: challengeB.accountId,
      challengeBPlatformAccountId: challengeB.platformAccountId,
    };
    run.status = "READY";
    await run.save();

    return run.toObject();
  } catch (error) {
    run.status = "FAIL";
    run.finishedAt = new Date();
    run.error = errorDetails(error);
    await run.save().catch(() => {});
    await closeFixtureAccounts(run, "fixture creation failed").catch(() => {});
    throw error;
  }
}

async function traderRequest(pathname, {
  method = "GET",
  body,
  bearer,
  headers = {},
  timeoutMs = 20000,
} = {}) {
  const base = String(env.ACG_TRADER_BASE_URL || "").replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(base + pathname, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text || null; }
    return { status: response.status, ok: response.ok, body: payload, headers: response.headers };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw acceptanceError(`Trader request timed out: ${pathname}`, "ACCEPTANCE_TRADER_TIMEOUT", 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function traderInternal(pathname, options = {}) {
  return traderRequest(pathname, {
    ...options,
    bearer: env.ACG_TRADER_API_KEY,
    headers: {
      "x-acg-client-id": env.ACG_TRADER_CLIENT_ID,
      ...(options.headers || {}),
    },
  });
}

async function traderSession(pathname, token, options = {}) {
  return traderRequest(pathname, { ...options, bearer: token });
}

async function requireResponse(response, expected, label) {
  const allowed = [].concat(expected);
  if (!allowed.includes(response.status)) {
    const error = acceptanceError(
      `${label} returned HTTP ${response.status}`,
      response.body?.code || response.body?.error?.code || "ACCEPTANCE_HTTP_ERROR",
      response.status || 500,
    );
    error.body = response.body;
    throw error;
  }
  return response;
}

async function adminRequest(fundedBaseUrl, adminBearer, pathname, { method = "GET", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(new URL(pathname, fundedBaseUrl).toString(), {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${adminBearer}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text || null; }
    return { status: response.status, body: payload };
  } finally {
    clearTimeout(timer);
  }
}

async function loadRun(runIdValue) {
  const run = await AcceptanceRun.findOne({ runId: String(runIdValue) });
  if (!run) throw acceptanceError("Acceptance run not found.", "ACCEPTANCE_RUN_NOT_FOUND", 404);
  return run;
}

async function loadCustomerForRun(run) {
  const customer = await Customer.findOne({ customerId: run.fixture?.customerId });
  if (!customer) throw acceptanceError("Acceptance fixture customer is missing.", "ACCEPTANCE_CUSTOMER_MISSING", 409);
  return customer;
}

async function loadChallenge(accountId) {
  return Account.findOne({ accountId: String(accountId) }).lean();
}

async function loadTraderAccount(platformAccountId) {
  const response = await traderInternal(`/v1/internal/trading/accounts/${encodeURIComponent(platformAccountId)}`);
  await requireResponse(response, 200, "Trader account inspection");
  return response.body?.account;
}

async function poll(fn, predicate, description, {
  timeoutMs = RUN_TIMEOUT_MS,
  intervalMs = POLL_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let cause = null;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (await predicate(last)) return last;
      cause = null;
    } catch (error) {
      cause = error;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  const error = acceptanceError(`Timed out waiting for ${description}.`, "ACCEPTANCE_POLL_TIMEOUT", 504);
  error.lastValue = last;
  error.cause = cause;
  throw error;
}

function adjustmentToTarget(account, buffer = 5) {
  const initial = Number(account?.initialDeposit || account?.accountSize || 0);
  const phase = Number(account?.currentPhase || 1);
  const rule = (account?.rules?.phases || []).find(item => Number(item?.phase) === phase);
  const percent = Number(rule?.profitTarget);
  const balance = Number(account?.balance);
  if (!(initial > 0) || !Number.isFinite(percent) || !Number.isFinite(balance)) {
    throw acceptanceError("Acceptance account is missing target/balance data.", "ACCEPTANCE_TARGET_INVALID", 409);
  }
  const targetBalance = initial + initial * percent / 100;
  return Math.max(0.01, targetBalance - balance + Math.max(0, Number(buffer) || 0));
}

async function adjustToPass(account, run, label) {
  const amount = adjustmentToTarget(account);
  const response = await traderInternal(
    `/v1/internal/trading/accounts/${encodeURIComponent(account.platformAccountId)}/ledger`,
    {
      method: "POST",
      body: {
        type: "ADJUSTMENT",
        amount: amount.toFixed(2),
        idempotencyKey: `admin-accept-${run.runId}-${label}-target`,
        referenceId: `admin-acceptance:${run.runId}:${label}`,
        reason: "Admin launch-readiness profit-target adjustment",
        metadata: { runId: run.runId, label, purpose: "admin-launch-readiness" },
      },
    },
  );
  await requireResponse(response, [200, 201], `${label} target adjustment`);
  return { amount, response: response.body };
}

function accountIds(rows) {
  return (rows || []).map(item => String(item?.id || item?._id || item?.accountId || "")).filter(Boolean);
}

async function exchangeLaunch(customer, accountId) {
  const launch = await createCustomerTradingLaunch(customer, accountId);
  const ticket = new URL(launch.launchUrl).searchParams.get("ticket");
  assert(ticket, "Trading launch URL did not contain a federation ticket.");
  const exchange = await traderRequest("/v1/auth/federated/exchange", {
    method: "POST",
    body: { ticket },
  });
  await requireResponse(exchange, 200, "Federation exchange");
  const token = exchange.body?.accessToken;
  assert(token, "Federation exchange did not return an access token.");
  const accounts = await traderSession("/v1/auth/accounts", token);
  await requireResponse(accounts, 200, "Trader accounts");
  return { launch, token, accounts: accounts.body?.accounts || [] };
}

async function tradeRoundTrip(platformAccountId, token, run, label) {
  const clientOrderId = `accept-${run.runId}-${label}-open`.slice(0, 120);
  const opened = await traderSession("/v1/trading/orders/market", token, {
    method: "POST",
    body: {
      accountId: platformAccountId,
      clientOrderId,
      symbol: run.symbol,
      side: "BUY",
      volume: run.volume,
      source: "API",
    },
  });
  await requireResponse(opened, [200, 201], `${label} market open`);
  assert.equal(String(opened.body?.order?.accountId), String(platformAccountId), `${label} open routed to wrong account.`);
  assert.equal(String(opened.body?.position?.accountId), String(platformAccountId), `${label} position routed to wrong account.`);
  assert(opened.body?.position?.id, `${label} did not return a position id.`);

  const history = await traderSession(
    `/v1/trading/accounts/${encodeURIComponent(platformAccountId)}/history/orders?limit=30`,
    token,
  );
  await requireResponse(history, 200, `${label} order history`);
  const persisted = (history.body?.items || []).find(item => item.clientOrderId === clientOrderId);
  assert(persisted, `${label} open order not found in durable history.`);
  assert.equal(String(persisted.accountId), String(platformAccountId), `${label} durable history routed to wrong account.`);

  const closeClientOrderId = `accept-${run.runId}-${label}-close`.slice(0, 120);
  const closed = await traderSession(
    `/v1/trading/positions/${encodeURIComponent(opened.body.position.id)}/close`,
    token,
    {
      method: "POST",
      body: {
        accountId: platformAccountId,
        clientOrderId: closeClientOrderId,
        source: "API",
      },
    },
  );
  await requireResponse(closed, [200, 201], `${label} close`);
  assert.equal(String(closed.body?.order?.accountId), String(platformAccountId), `${label} close routed to wrong account.`);

  return {
    selectedPlatformAccountId: platformAccountId,
    openOrderId: opened.body?.order?.orderId,
    closeOrderId: closed.body?.order?.orderId,
    positionId: opened.body?.position?.positionId || opened.body?.position?.id,
  };
}

async function expectTradingRejected(platformAccountId, token, run, label) {
  const response = await traderSession("/v1/trading/orders/market", token, {
    method: "POST",
    body: {
      accountId: platformAccountId,
      clientOrderId: `accept-${run.runId}-${label}-rejected`.slice(0, 120),
      symbol: run.symbol,
      side: "BUY",
      volume: run.volume,
      source: "API",
    },
  });
  assert(![200, 201].includes(response.status), `${label} unexpectedly accepted trading.`);
  return {
    status: response.status,
    code: response.body?.code || response.body?.error?.code || null,
    message: response.body?.message || response.body?.error?.message || null,
  };
}

function activePlatformAccounts(account, { accountType = null } = {}) {
  return (account?.platformAccounts || []).filter(item => {
    if (String(item?.status || "").toUpperCase() !== "ACTIVE") return false;
    if (accountType && String(item?.accountType || "").toUpperCase() !== String(accountType).toUpperCase()) return false;
    return true;
  });
}

function inspectV2Observability(observability) {
  const account = observability?.account || {};
  const policy = account.riskPolicy || {};
  const nullKeys = [
    "maxRiskPerTradePercent",
    "maxAggregateRiskPercent",
    "maxMarginUsagePercent",
    "maxSingleOrderMarginPercentOfFree",
    "maxSymbolMarginPercentOfPermitted",
  ];
  return {
    riskPolicyVersion: account?.challenge?.riskPolicyVersion || null,
    fundedV2Confirmed: account?.capabilities?.fundedV2Confirmed === true,
    optionalStopLoss: account?.capabilities?.optionalStopLoss === true,
    manualLotWithoutStopLoss: account?.capabilities?.manualLotWithoutStopLoss === true,
    disabledLimitsNull: nullKeys.every(key => Object.prototype.hasOwnProperty.call(policy, key) && policy[key] == null),
  };
}

export async function preflightAcceptanceRun(runIdValue) {
  const run = await loadRun(runIdValue);
  if (!["READY", "FAIL"].includes(run.status)) {
    throw acceptanceError(
      `Preflight is not available while run status is ${run.status}.`,
      "ACCEPTANCE_PREFLIGHT_STATE_INVALID",
      409,
    );
  }

  const customer = await loadCustomerForRun(run);
  const challengeA = await loadChallenge(run.fixture?.challengeAId);
  const challengeB = await loadChallenge(run.fixture?.challengeBId);
  const checks = [];

  const add = (name, pass, detail = null) => checks.push({ name, status: pass ? "PASS" : "FAIL", detail });

  add("Risk policy selector is V2", resolveProvisioningRiskPolicyVersion() === ACG_FUNDED_RISK_POLICY_V2_VERSION, resolveProvisioningRiskPolicyVersion());
  add("Acceptance customer exists and is active", Boolean(customer) && customer.status === "ACTIVE", customer?.customerId || null);

  for (const [label, account] of [["Challenge A", challengeA], ["Challenge B", challengeB]]) {
    add(`${label} exists`, Boolean(account), account?.accountId || null);
    add(`${label} is two-step Phase 1`, Boolean(account)
      && account.challengeType === "TWO_STEP"
      && Number(account.currentPhase) === 1
      && account.status === "ACTIVE"
      && account.enabled === true,
    account ? { status: account.status, phase: account.currentPhase } : null);
    add(`${label} minimum trading days is zero`, Number(account?.rules?.minimumTradingDays) === 0, account?.rules?.minimumTradingDays ?? null);
  }

  const traderHealth = await traderRequest("/health/live");
  add("ACG Trader health", traderHealth.status === 200, { status: traderHealth.status });

  for (const [label, account] of [["Challenge A", challengeA], ["Challenge B", challengeB]]) {
    if (!account?.platformAccountId) {
      add(`${label} Trader provisioning`, false, "Missing platformAccountId");
      continue;
    }
    const connector = getTradingConnector("acg-trader");
    const obs = await connector.adminObservability({ platformAccountId: account.platformAccountId, limit: 30 });
    const v2 = inspectV2Observability(obs);
    add(`${label} Trader account active`,
      String(obs?.account?.status || "").toUpperCase() === "ACTIVE" && obs?.account?.tradingEnabled === true,
      { status: obs?.account?.status, tradingEnabled: obs?.account?.tradingEnabled });
    add(`${label} V2 capabilities confirmed`,
      v2.riskPolicyVersion === ACG_FUNDED_RISK_POLICY_V2_VERSION
        && v2.fundedV2Confirmed
        && v2.optionalStopLoss
        && v2.manualLotWithoutStopLoss
        && v2.disabledLimitsNull,
      v2);
  }

  const passed = checks.every(item => item.status === "PASS");
  run.preflight = { status: passed ? "PASS" : "FAIL", checkedAt: new Date(), checks };
  if (run.status === "FAIL" && passed && !run.startedAt) run.status = "READY";
  await run.save();

  return {
    runId: run.runId,
    status: run.preflight.status,
    checks,
    fixture: run.fixture,
    symbol: run.symbol,
    volume: run.volume,
  };
}

async function saveScenario(run, scenario, evidence) {
  const report = run.report || { scenarios: [], evidence: {}, summary: { pass: 0, fail: 0, total: 0 } };
  report.scenarios = [...(report.scenarios || []), scenario];
  report.evidence = { ...(report.evidence || {}), ...(evidence || {}) };
  report.summary = {
    pass: report.scenarios.filter(item => item.status === "PASS").length,
    fail: report.scenarios.filter(item => item.status === "FAIL").length,
    total: report.scenarios.length,
  };
  run.report = report;
  run.markModified("report");
  await run.save();
}

async function scenario(run, name, fn) {
  const startedAt = new Date();
  try {
    const result = await fn();
    await saveScenario(run, {
      name,
      status: "PASS",
      startedAt,
      finishedAt: new Date(),
      summary: result?.summary || null,
    }, result?.evidence || null);
    return result;
  } catch (error) {
    await saveScenario(run, {
      name,
      status: "FAIL",
      startedAt,
      finishedAt: new Date(),
      error: errorDetails(error),
    });
    throw error;
  }
}

export async function executeAcceptanceRun(runIdValue, {
  confirmation,
  reason,
  adminBearer,
  fundedBaseUrl,
} = {}) {
  validateAcceptanceConfirmation({ confirmation, reason });
  if (!adminBearer) throw acceptanceError("Admin bearer is required for lifecycle approval checks.", "ACCEPTANCE_ADMIN_SESSION_REQUIRED", 401);
  if (!fundedBaseUrl) throw acceptanceError("Funded API base URL is required.", "ACCEPTANCE_FUNDED_BASE_URL_REQUIRED");

  let run = await AcceptanceRun.findOneAndUpdate(
    { runId: String(runIdValue), status: "READY" },
    {
      $set: {
        status: "RUNNING",
        reason: String(reason).trim(),
        startedAt: new Date(),
        finishedAt: null,
        error: null,
        report: { scenarios: [], evidence: {}, summary: { pass: 0, fail: 0, total: 0 } },
      },
    },
    { new: true },
  );
  if (!run) {
    const current = await loadRun(runIdValue);
    throw acceptanceError(
      `Acceptance run must be READY before execution (current=${current.status}).`,
      "ACCEPTANCE_RUN_NOT_READY",
      409,
    );
  }

  try {
    const preflight = await preflightAcceptanceRun(run.runId);
    assert.equal(preflight.status, "PASS", "Preflight must pass before destructive acceptance.");

    const customerRecord = await loadCustomerForRun(run);
    const customer = customerContext(customerRecord);
    const state = {
      trial: null,
      traderToken: null,
      phase1A: run.fixture.challengeAPlatformAccountId,
      phase1B: run.fixture.challengeBPlatformAccountId,
      phase2A: null,
      masterA: null,
    };

    await scenario(run, "1. Deployed health, identity, V2 and fixture preflight", async () => ({
      summary: "Funded fixture and ACG Trader V2 provisioning checks passed.",
      evidence: { preflight },
    }));

    await scenario(run, "2. Concurrent Trial creation enforces exactly one active Trial", async () => {
      const body = {
        challengeDefinition: {
          step: "1step",
          accountSize: ACCOUNT_SIZE,
          rules: {
            profitTarget: PHASE_TARGET_PERCENT,
            dailyLoss: 5,
            maxLoss: 10,
            minTradingDays: 0,
          },
        },
      };

      const settled = await Promise.allSettled([
        ensureDemoAccount(customer, body),
        ensureDemoAccount(customer, body),
      ]);
      const successes = settled.filter(item => item.status === "fulfilled");
      const conflicts = settled.filter(item =>
        item.status === "rejected"
        && (Number(item.reason?.status) === 409 || item.reason?.code === "ACTIVE_TRIAL_EXISTS")
      );
      assert.equal(successes.length, 1, "Concurrent Trial requests did not produce exactly one success.");
      assert.equal(conflicts.length, 1, "Concurrent Trial requests did not produce exactly one conflict.");

      state.trial = successes[0].value;
      run.fixture = {
        ...run.fixture,
        trialAccountId: state.trial.accountId,
        trialPlatformAccountId: state.trial.platformAccountId,
      };
      run.markModified("fixture");
      await run.save();

      const activeTrials = await Account.find({
        customerId: customer.customerId,
        accountMode: "DEMO",
        status: { $in: ["NEW", "ACTIVE", "PHASE_2"] },
        enabled: true,
      }).lean();
      assert.equal(activeTrials.length, 1, "Database invariant allowed more than one active Trial.");

      return {
        summary: "One Trial created; concurrent request rejected.",
        evidence: {
          trialConcurrency: {
            trialAccountId: state.trial.accountId,
            platformAccountId: state.trial.platformAccountId,
            successCount: successes.length,
            conflictCount: conflicts.length,
          },
        },
      };
    });

    await scenario(run, "3. One federated Trader session grants Trial + multiple Challenges", async () => {
      const session = await exchangeLaunch(customer, run.fixture.challengeAId);
      state.traderToken = session.token;
      const ids = new Set(accountIds(session.accounts));
      const expected = [state.trial.platformAccountId, state.phase1A, state.phase1B].map(String);
      for (const id of expected) assert(ids.has(id), `Federated session is missing expected account ${id}.`);
      return {
        summary: "Single session grants all currently tradable acceptance accounts.",
        evidence: {
          federation: {
            selectedPlatformAccountId: session.launch?.selectedPlatformAccountId,
            grantedAccountIds: [...ids],
            expected,
          },
        },
      };
    });

    await scenario(run, "4. Multi-account switching/order routing stays on selected account", async () => {
      const routed = [];
      routed.push(await tradeRoundTrip(state.trial.platformAccountId, state.traderToken, run, "trial"));
      routed.push(await tradeRoundTrip(state.phase1A, state.traderToken, run, "challenge-a-p1"));
      routed.push(await tradeRoundTrip(state.phase1B, state.traderToken, run, "challenge-b-p1"));
      routed.push(await tradeRoundTrip(state.phase1A, state.traderToken, run, "challenge-a-p1-return"));
      return {
        summary: "Open, close and durable history stayed on the selected account.",
        evidence: { routing: routed },
      };
    });

    await scenario(run, "5. Trial reaches target, becomes PASSED, and cannot relaunch", async () => {
      const trial = await loadChallenge(state.trial.accountId);
      const adjustment = await adjustToPass(trial, run, "trial-pass");
      const passed = await poll(
        () => loadChallenge(trial.accountId),
        account => String(account?.status || "").toUpperCase() === "PASSED" && account?.enabled === false,
        "Trial PASSED terminal state",
      );
      const remote = await loadTraderAccount(trial.platformAccountId);
      assert(["DISABLED", "BREACHED", "CLOSED"].includes(String(remote?.status || "").toUpperCase()), "Passed Trial remained tradable.");
      let relaunchStatus = 200;
      try {
        await createCustomerTradingLaunch(customer, trial.accountId);
      } catch (error) {
        relaunchStatus = Number(error?.status || 500);
      }
      assert.equal(relaunchStatus, 409, "Passed Trial unexpectedly remained launchable.");
      return {
        summary: "Trial terminal completion propagated to Funded and Trader.",
        evidence: { trialCompletion: { adjustment: adjustment.amount, fundedStatus: passed.status, traderStatus: remote.status, relaunchStatus } },
      };
    });

    await scenario(run, "6. Challenge A Phase 1 passes into a distinct active Phase 2 account", async () => {
      const before = await loadChallenge(run.fixture.challengeAId);
      const p1 = before.platformAccountId;
      const adjustment = await adjustToPass(before, run, "challenge-a-phase1");
      const phase2 = await poll(
        () => loadChallenge(run.fixture.challengeAId),
        account =>
          String(account?.status || "").toUpperCase() === "PHASE_2"
          && Number(account?.currentPhase) === 2
          && account?.enabled === true
          && String(account?.platformAccountId || "") !== String(p1),
        "Challenge A Phase 2 activation",
      );
      state.phase2A = phase2.platformAccountId;
      const [oldRemote, newRemote] = await Promise.all([loadTraderAccount(p1), loadTraderAccount(state.phase2A)]);
      assert.equal(String(oldRemote?.status || "").toUpperCase(), "DISABLED", "Superseded Phase 1 was not disabled.");
      assert.equal(String(newRemote?.status || "").toUpperCase(), "ACTIVE", "Phase 2 Trader account is not ACTIVE.");
      assert.equal(newRemote?.tradingEnabled, true, "Phase 2 Trader account is not trading-enabled.");
      const oldRejected = await expectTradingRejected(p1, state.traderToken, run, "old-phase1");
      return {
        summary: "Phase 2 is distinct and Phase 1 rejects new exposure.",
        evidence: {
          phase1ToPhase2: {
            adjustment: adjustment.amount,
            oldPlatformAccountId: p1,
            newPlatformAccountId: state.phase2A,
            oldTraderStatus: oldRemote.status,
            newTraderStatus: newRemote.status,
            oldAccountTradingAttempt: oldRejected,
          },
        },
      };
    });

    await scenario(run, "7. Breach racing a promotion wins and no active successor survives", async () => {
      const before = await loadChallenge(run.fixture.challengeBId);
      const p1 = before.platformAccountId;
      const adjustmentPromise = adjustToPass(before, run, "challenge-b-race");
      await new Promise(resolve => setTimeout(resolve, BREACH_RACE_DELAY_MS));
      const breachPromise = traderInternal(`/v1/internal/trading/accounts/${encodeURIComponent(p1)}/breach`, {
        method: "POST",
        body: { reason: "ACCEPTANCE_BREACH_DURING_PROMOTION", action: "LOCK_ONLY" },
      });
      const [adjustment, breach] = await Promise.all([adjustmentPromise, breachPromise]);
      await requireResponse(breach, 200, "Acceptance breach");

      const terminal = await poll(
        () => loadChallenge(run.fixture.challengeBId),
        account => String(account?.status || "").toUpperCase() === "BREACHED" && account?.enabled === false,
        "Challenge B terminal breach",
      );
      const activeSuccessors = activePlatformAccounts(terminal).filter(item => String(item.platformAccountId) !== String(p1));
      assert.equal(activeSuccessors.length, 0, "A successor account remained ACTIVE after breach race.");
      assert.equal(terminal.commandPending, null, "A lifecycle promotion command remained pending after breach.");
      const remote = await loadTraderAccount(p1);
      assert.equal(String(remote?.status || "").toUpperCase(), "BREACHED", "Trader did not preserve BREACHED as terminal.");

      return {
        summary: "Breach won the transition race; no active successor survived.",
        evidence: {
          breachRace: {
            adjustment: adjustment.amount,
            breachOperation: breach.body?.operation || null,
            fundedStatus: terminal.status,
            commandPending: terminal.commandPending,
            traderStatus: remote.status,
            activeSuccessorCount: activeSuccessors.length,
          },
        },
      };
    });

    await scenario(run, "8. Challenge A Phase 2 passes to non-tradable Funded Review", async () => {
      const before = await loadChallenge(run.fixture.challengeAId);
      assert.equal(String(before.status).toUpperCase(), "PHASE_2", "Challenge A is not in Phase 2.");
      const p2 = before.platformAccountId;
      const adjustment = await adjustToPass(before, run, "challenge-a-phase2");
      const review = await poll(
        () => loadChallenge(run.fixture.challengeAId),
        account => String(account?.status || "").toUpperCase() === "FUNDED_REVIEW" && account?.enabled === false,
        "Funded Review",
      );

      let launchStatus = 200;
      try {
        await createCustomerTradingLaunch(customer, run.fixture.challengeAId);
      } catch (error) {
        launchStatus = Number(error?.status || 500);
      }
      assert.equal(launchStatus, 409, "Funded Review unexpectedly remained launchable.");

      const p2Remote = await loadTraderAccount(p2);
      assert.equal(String(p2Remote?.status || "").toUpperCase(), "DISABLED", "Completed Phase 2 was not disabled.");
      const sessionAccounts = await traderSession("/v1/auth/accounts", state.traderToken);
      await requireResponse(sessionAccounts, 200, "Funded Review account visibility");
      const visibleMaster = (sessionAccounts.body?.accounts || []).find(item =>
        String(item?.accountType || "").toUpperCase() === "FUNDED"
        && String(item?.challenge?.fundedAccountId || "") === String(run.fixture.challengeAId)
      );
      assert.equal(Boolean(visibleMaster), false, "A Master account became visible during Funded Review.");

      return {
        summary: "Funded Review is non-tradable and exposes no Master account.",
        evidence: {
          fundedReview: {
            adjustment: adjustment.amount,
            status: review.status,
            launchStatus,
            phase2TraderStatus: p2Remote.status,
            visibleMaster: Boolean(visibleMaster),
          },
        },
      };
    });

    await scenario(run, "9. Concurrent Master approval creates exactly one active Master", async () => {
      const path = `/api/admin/challenges/${encodeURIComponent(run.fixture.challengeAId)}/action`;
      const body = { action: "APPROVE_FUNDED", reason: `Launch readiness double approval ${run.runId}` };
      const [left, right] = await Promise.all([
        adminRequest(fundedBaseUrl, adminBearer, path, { method: "POST", body }),
        adminRequest(fundedBaseUrl, adminBearer, path, { method: "POST", body }),
      ]);
      const successes = [left, right].filter(item => item.status === 200);
      const conflicts = [left, right].filter(item => item.status === 409);
      assert.equal(successes.length, 1, "Concurrent Master approval did not produce exactly one success.");
      assert.equal(conflicts.length, 1, "Concurrent Master approval did not produce exactly one conflict.");

      const funded = await poll(
        () => loadChallenge(run.fixture.challengeAId),
        account => String(account?.status || "").toUpperCase() === "FUNDED" && account?.enabled === true,
        "active Master account",
      );
      const masters = (funded.platformAccounts || []).filter(item => String(item?.accountType || "").toUpperCase() === "FUNDED");
      const activeMasters = masters.filter(item => String(item?.status || "").toUpperCase() === "ACTIVE");
      assert.equal(masters.length, 1, "More than one Master platform account was created.");
      assert.equal(activeMasters.length, 1, "Exactly one Master platform account was not ACTIVE.");
      state.masterA = activeMasters[0].platformAccountId;
      const remote = await loadTraderAccount(state.masterA);
      assert.equal(String(remote?.status || "").toUpperCase(), "ACTIVE", "Master Trader account is not ACTIVE.");
      assert.equal(remote?.tradingEnabled, true, "Master Trader account is not trading-enabled.");

      return {
        summary: "Double approval serialized into one active Master.",
        evidence: {
          masterApproval: {
            responseStatuses: [left.status, right.status],
            responseCodes: [left.body?.code || null, right.body?.code || null],
            masterPlatformAccountId: state.masterA,
            masterCount: masters.length,
            activeMasterCount: activeMasters.length,
            traderStatus: remote.status,
          },
        },
      };
    });

    await scenario(run, "10. Master routing stays correct", async () => {
      const session = await exchangeLaunch(customer, run.fixture.challengeAId);
      assert.equal(String(session.launch?.selectedPlatformAccountId), String(state.masterA), "Funded launch did not select Master.");
      const routed = await tradeRoundTrip(state.masterA, session.token, run, "master");
      return {
        summary: "Master account launch and order routing passed.",
        evidence: { masterRouting: routed },
      };
    });

    run.status = "PASS";
    run.finishedAt = new Date();
    run.error = null;
    await run.save();
    return run.toObject();
  } catch (error) {
    run = await AcceptanceRun.findOne({ runId: String(runIdValue) }) || run;
    run.status = "FAIL";
    run.finishedAt = new Date();
    run.error = errorDetails(error);
    await run.save().catch(() => {});
    throw error;
  }
}

export async function cleanupAcceptanceRun(runIdValue, { reason } = {}) {
  const text = String(reason || "").trim();
  if (text.length < 5) throw acceptanceError("A cleanup reason of at least 5 characters is required.", "ACCEPTANCE_CLEANUP_REASON_REQUIRED");
  const run = await loadRun(runIdValue);
  if (run.status === "RUNNING") {
    throw acceptanceError("A running acceptance test cannot be cleaned up.", "ACCEPTANCE_CLEANUP_RUNNING", 409);
  }
  if (run.status === "CLEANED") return run.toObject();

  const errors = await closeFixtureAccounts(run, text);
  run.status = "CLEANED";
  run.cleanedAt = new Date();
  run.error = errors.length ? { code: "ACCEPTANCE_CLEANUP_PARTIAL", errors } : null;
  await run.save();
  return run.toObject();
}

export async function listAcceptanceRuns({ limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  return AcceptanceRun.find({}).sort({ createdAt: -1 }).limit(safeLimit).lean();
}

export async function getAcceptanceRun(runIdValue) {
  const run = await AcceptanceRun.findOne({ runId: String(runIdValue) }).lean();
  if (!run) throw acceptanceError("Acceptance run not found.", "ACCEPTANCE_RUN_NOT_FOUND", 404);
  return run;
}

export const ACCEPTANCE_RUN_CONFIRMATION = RUN_CONFIRMATION;
