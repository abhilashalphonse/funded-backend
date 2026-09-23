import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  AcceptanceReport,
  activePlatformAccounts,
  adjustmentToTarget,
  assertAcceptanceIdentity,
  extractFederationTicket,
  httpJson,
  loadAcceptanceConfig,
  poll,
  sleep,
  validateAcceptanceConfig,
} from "./lifecycle-acceptance/lib.js";

const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + crypto.randomUUID().slice(0, 8);
const config = validateAcceptanceConfig(loadAcceptanceConfig());
const report = new AcceptanceReport({
  runId,
  config: {
    fundedBaseUrl: config.fundedBaseUrl,
    traderBaseUrl: config.traderBaseUrl,
    customerId: config.customerId,
    challengeAId: config.challengeAId,
    challengeBId: config.challengeBId,
    symbol: config.symbol,
    volume: config.volume,
    dryRun: config.dryRun,
    requireAll: config.requireAll,
  },
});

const state = {
  customer: null,
  challengeA: null,
  challengeB: null,
  trial: null,
  traderToken: null,
  traderAccounts: [],
  phase1A: null,
  phase2A: null,
  phase1B: null,
  masterA: null,
};

function fundedCustomer(pathname, options = {}) {
  return httpJson(config.fundedBaseUrl, pathname, {
    ...options,
    bearer: config.customerBearer,
    timeoutMs: options.timeoutMs || 20000,
  });
}

function fundedAdmin(pathname, options = {}) {
  return httpJson(config.fundedBaseUrl, pathname, {
    ...options,
    bearer: config.adminBearer,
    timeoutMs: options.timeoutMs || 20000,
  });
}

function traderInternal(pathname, options = {}) {
  return httpJson(config.traderBaseUrl, pathname, {
    ...options,
    bearer: config.traderServiceKey,
    headers: {
      "x-acg-client-id": config.traderClientId,
      ...(options.headers || {}),
    },
    timeoutMs: options.timeoutMs || 20000,
  });
}

function traderSession(pathname, token, options = {}) {
  return httpJson(config.traderBaseUrl, pathname, {
    ...options,
    bearer: token,
    timeoutMs: options.timeoutMs || 20000,
  });
}

async function loadCustomer() {
  const response = await fundedAdmin("/api/admin/users/" + encodeURIComponent(config.customerId), { expected: 200 });
  return response.body?.data;
}

async function loadChallenge(accountId) {
  const response = await fundedAdmin("/api/admin/challenges/" + encodeURIComponent(accountId), { expected: 200 });
  return response.body?.data?.account;
}

async function loadTraderAccount(platformAccountId) {
  const response = await traderInternal("/v1/internal/trading/accounts/" + platformAccountId, { expected: 200 });
  return response.body?.account;
}

async function waitForChallenge(accountId, predicate, description) {
  return poll(
    () => loadChallenge(accountId),
    predicate,
    { timeoutMs: config.timeoutMs, intervalMs: config.pollMs, description },
  );
}

function validatePaidFixture(account, label) {
  assert(account, label + " was not found.");
  assert.equal(account.customerId, config.customerId, label + " does not belong to the acceptance customer.");
  assert.equal(String(account.accountMode).toUpperCase(), "CHALLENGE", label + " is not a paid Challenge.");
  assert.equal(String(account.platform).toLowerCase(), "acg-trader", label + " is not on ACG Trader.");
  assert.equal(String(account.challengeType).toUpperCase(), "TWO_STEP", label + " must be a two-step Challenge.");
  assert.equal(Number(account.currentPhase || 1), 1, label + " must start in Phase 1.");
  assert.equal(String(account.status).toUpperCase(), "ACTIVE", label + " must start ACTIVE.");
  assert.equal(account.enabled, true, label + " must start enabled.");
  assert.equal(Number(account.rules?.minimumTradingDays || 0), 0, label + " must use minimumTradingDays=0 for deterministic acceptance.");
  assert.match(String(account.platformAccountId || ""), /^[0-9a-f]{24}$/i, label + " is missing a valid Trader platformAccountId.");
}

async function exchangeLaunch(accountId) {
  const launch = await fundedCustomer("/api/customer/accounts/" + encodeURIComponent(accountId) + "/trading-launch", {
    method: "POST",
    body: {},
    expected: 200,
  });
  const ticket = extractFederationTicket(launch.body?.data?.launchUrl);
  const exchange = await httpJson(config.traderBaseUrl, "/v1/auth/federated/exchange", {
    method: "POST",
    body: { ticket },
    expected: 200,
  });
  assert(exchange.body?.accessToken, "Federation exchange did not return an access token.");
  const accounts = await traderSession("/v1/auth/accounts", exchange.body.accessToken, { expected: 200 });
  return { launch: launch.body?.data, token: exchange.body.accessToken, accounts: accounts.body?.accounts || [] };
}

function accountIds(rows) {
  return (rows || []).map(item => String(item?.id || item?._id || item?.accountId || "")).filter(Boolean);
}

async function tradeRoundTrip(platformAccountId, token, label) {
  const selectedPlatformAccountId = platformAccountId;
  const clientOrderId = "accept-" + runId + "-" + label + "-open";
  const opened = await traderSession("/v1/trading/orders/market", token, {
    method: "POST",
    body: {
      accountId: selectedPlatformAccountId,
      clientOrderId,
      symbol: config.symbol,
      side: "BUY",
      volume: config.volume,
      source: "API",
    },
    expected: [200, 201],
  });

  assert.equal(String(opened.body?.order?.accountId), selectedPlatformAccountId, label + " open order routed to wrong account.");
  assert.equal(String(opened.body?.position?.accountId), selectedPlatformAccountId, label + " position routed to wrong account.");
  assert(opened.body?.position?.id, label + " did not return a position id.");

  const history = await traderSession(
    "/v1/trading/accounts/" + selectedPlatformAccountId + "/history/orders?limit=30",
    token,
    { expected: 200 },
  );
  const persistedOpen = (history.body?.items || []).find(item => item.clientOrderId === clientOrderId);
  assert(persistedOpen, label + " open order not found in durable history.");
  assert.equal(String(persistedOpen.accountId), selectedPlatformAccountId, label + " durable order history routed to wrong account.");

  const closeClientOrderId = "accept-" + runId + "-" + label + "-close";
  const closed = await traderSession("/v1/trading/positions/" + opened.body.position.id + "/close", token, {
    method: "POST",
    body: {
      accountId: selectedPlatformAccountId,
      clientOrderId: closeClientOrderId,
      source: "API",
    },
    expected: [200, 201],
  });
  assert.equal(String(closed.body?.order?.accountId), selectedPlatformAccountId, label + " close order routed to wrong account.");
  assert.equal(String(closed.body?.position?.accountId), selectedPlatformAccountId, label + " closed position belongs to wrong account.");

  return {
    selectedPlatformAccountId,
    openOrderId: opened.body?.order?.orderId,
    closeOrderId: closed.body?.order?.orderId,
    positionId: opened.body?.position?.positionId,
  };
}

async function adjustToPass(account, label) {
  const amount = adjustmentToTarget(account, config.targetBuffer);
  const platformAccountId = String(account.platformAccountId);
  const response = await traderInternal("/v1/internal/trading/accounts/" + platformAccountId + "/ledger", {
    method: "POST",
    body: {
      type: "ADJUSTMENT",
      amount: amount.toFixed(2),
      idempotencyKey: "accept-" + runId + "-" + label + "-target",
      referenceId: "acceptance:" + runId + ":" + label,
      reason: "Lifecycle acceptance profit-target adjustment",
      metadata: { runId, label, purpose: "lifecycle-acceptance" },
    },
    expected: [200, 201],
  });
  return { amount, response: response.body };
}

async function expectTradingRejected(platformAccountId, token, label) {
  const response = await traderSession("/v1/trading/orders/market", token, {
    method: "POST",
    body: {
      accountId: platformAccountId,
      clientOrderId: "accept-" + runId + "-" + label + "-rejected",
      symbol: config.symbol,
      side: "BUY",
      volume: config.volume,
      source: "API",
    },
  });
  assert.notEqual(response.status, 200, label + " unexpectedly accepted trading.");
  assert.notEqual(response.status, 201, label + " unexpectedly accepted trading.");
  return { status: response.status, code: response.body?.code || null, message: response.body?.message || null };
}

async function abortIfLastScenarioFailed() {
  const last = report.scenarios.at(-1);
  if (last?.status !== "FAIL") return;
  report.finish({ requireAll: config.requireAll });
  const files = await report.write(config.reportDir);
  console.error(JSON.stringify({
    runId: report.runId,
    status: report.status,
    summary: report.summary,
    stoppedAfter: last.name,
    reports: files,
  }, null, 2));
  process.exit(1);
}

async function maybeCloseExistingTrial() {
  const workspace = await loadCustomer();
  const active = (workspace?.accounts || []).filter(item =>
    String(item?.accountMode || "").toUpperCase() === "DEMO"
    && ["NEW", "ACTIVE", "PHASE_2"].includes(String(item?.status || "").toUpperCase())
    && item?.enabled === true
  );
  if (!active.length) return [];
  if (!config.cleanupExistingTrial) {
    throw new Error("Acceptance customer already has an active Trial. Set ACCEPTANCE_CLEANUP_EXISTING_TRIAL=YES to close it first.");
  }
  for (const trial of active) {
    await fundedAdmin("/api/admin/challenges/" + encodeURIComponent(trial.accountId) + "/action", {
      method: "POST",
      body: { action: "CLOSE", reason: "Acceptance runner preflight cleanup " + runId },
      expected: 200,
    });
  }
  return active.map(item => item.accountId);
}

await report.run("1. Deployed health, identity, and fixture preflight", async () => {
  const [fundedHealth, traderHealth, customer, a, b] = await Promise.all([
    httpJson(config.fundedBaseUrl, "/health", { expected: 200 }),
    httpJson(config.traderBaseUrl, "/health/live", { expected: 200 }),
    loadCustomer(),
    loadChallenge(config.challengeAId),
    loadChallenge(config.challengeBId),
  ]);

  assert.equal(fundedHealth.body?.tradingProvider, "acg-trader", "Funded production is not using ACG Trader.");
  assert(customer?.customer, "Admin customer lookup did not return the customer.");
  assertAcceptanceIdentity(customer.customer.primaryEmail, config.identityPattern, config.allowNonTestIdentity);
  validatePaidFixture(a, "Challenge A");
  validatePaidFixture(b, "Challenge B");

  state.customer = customer;
  state.challengeA = a;
  state.challengeB = b;
  state.phase1A = a.platformAccountId;
  state.phase1B = b.platformAccountId;

  report.evidence.preflight = {
    customerId: config.customerId,
    customerEmail: customer.customer.primaryEmail,
    challengeA: { accountId: a.accountId, platformAccountId: a.platformAccountId, status: a.status },
    challengeB: { accountId: b.accountId, platformAccountId: b.platformAccountId, status: b.status },
    fundedHealth: fundedHealth.body,
    traderHealth: traderHealth.body,
  };
  return { summary: "Both deployed services healthy; dedicated fixtures verified." };
});
await abortIfLastScenarioFailed();

if (!config.dryRun) {
  await report.run("2. Concurrent Trial creation enforces exactly one active Trial", async () => {
    const cleaned = await maybeCloseExistingTrial();
    const body = {
      challengeDefinition: {
        step: "1step",
        accountSize: config.trialSize,
        rules: {
          profitTarget: config.trialTargetPercent,
          dailyLoss: 5,
          maxLoss: 10,
          minTradingDays: 0,
        },
      },
    };

    const [left, right] = await Promise.all([
      fundedCustomer("/api/customer/demo-account", { method: "POST", body }),
      fundedCustomer("/api/customer/demo-account", { method: "POST", body }),
    ]);
    const results = [left, right];
    const successes = results.filter(item => item.status === 201);
    const conflicts = results.filter(item => item.status === 409);
    assert.equal(successes.length, 1, "Concurrent Trial requests did not produce exactly one success.");
    assert.equal(conflicts.length, 1, "Concurrent Trial requests did not produce exactly one conflict.");

    state.trial = successes[0].body?.data;
    assert(state.trial?.accountId, "Successful Trial creation did not return accountId.");
    assert.match(String(state.trial?.platformAccountId || ""), /^[0-9a-f]{24}$/i, "Trial did not return a Trader platform account.");

    const after = await loadCustomer();
    const activeTrials = (after?.accounts || []).filter(item =>
      String(item?.accountMode || "").toUpperCase() === "DEMO"
      && ["NEW", "ACTIVE", "PHASE_2"].includes(String(item?.status || "").toUpperCase())
      && item?.enabled === true
    );
    assert.equal(activeTrials.length, 1, "Database invariant allowed more than one active Trial.");

    report.evidence.trialConcurrency = {
      cleaned,
      statuses: results.map(item => ({ status: item.status, code: item.body?.code || null })),
      trialAccountId: state.trial.accountId,
      platformAccountId: state.trial.platformAccountId,
    };
    return { summary: "One Trial created; concurrent request rejected." };
  });
  await abortIfLastScenarioFailed();

  await report.run("3. One federated Trader session grants Trial + multiple Challenges", async () => {
    assert(state.trial?.accountId, "Trial scenario did not complete.");
    const session = await exchangeLaunch(config.challengeAId);
    state.traderToken = session.token;
    state.traderAccounts = session.accounts;
    const ids = new Set(accountIds(session.accounts));
    const expected = [state.trial.platformAccountId, state.phase1A, state.phase1B];
    for (const id of expected) assert(ids.has(String(id)), "Federated session is missing expected account " + id + ".");

    report.evidence.federation = {
      selectedPlatformAccountId: session.launch?.selectedPlatformAccountId,
      grantedAccountIds: [...ids],
      expected,
    };
    return { summary: "Single session grants all currently tradable acceptance accounts." };
  });
  await abortIfLastScenarioFailed();

  await report.run("4. Multi-account switching/order routing stays on the selected account", async () => {
    assert(state.traderToken, "Federated session token is missing.");
    const routed = [];
    routed.push(await tradeRoundTrip(state.trial.platformAccountId, state.traderToken, "trial"));
    routed.push(await tradeRoundTrip(state.phase1A, state.traderToken, "challenge-a-p1"));
    routed.push(await tradeRoundTrip(state.phase1B, state.traderToken, "challenge-b-p1"));
    routed.push(await tradeRoundTrip(state.phase1A, state.traderToken, "challenge-a-p1-return"));

    report.evidence.routing = routed;
    return { summary: "Every open/close order and durable history row matched the runner-selected platform account." };
  });
  await abortIfLastScenarioFailed();

  await report.run("5. Trial reaches target, becomes PASSED, and cannot relaunch", async () => {
    const trial = await loadChallenge(state.trial.accountId);
    const adjustment = await adjustToPass(trial, "trial-pass");
    const passed = await waitForChallenge(
      trial.accountId,
      account => String(account?.status || "").toUpperCase() === "PASSED" && account?.enabled === false,
      "Trial PASSED terminal state",
    );
    const remote = await loadTraderAccount(trial.platformAccountId);
    assert(["DISABLED", "BREACHED", "CLOSED"].includes(String(remote?.status || "").toUpperCase()), "Passed Trial Trader account remained tradable.");

    const relaunch = await fundedCustomer("/api/customer/accounts/" + encodeURIComponent(trial.accountId) + "/trading-launch", {
      method: "POST",
      body: {},
    });
    assert.equal(relaunch.status, 409, "Passed Trial unexpectedly remained launchable.");

    report.evidence.trialCompletion = {
      adjustment: adjustment.amount,
      fundedStatus: passed.status,
      traderStatus: remote.status,
      relaunchStatus: relaunch.status,
    };
    return { summary: "Trial terminal completion propagated to Funded and Trader." };
  });
  await abortIfLastScenarioFailed();

  await report.run("6. Challenge A Phase 1 passes into a distinct active Phase 2 account", async () => {
    const before = await loadChallenge(config.challengeAId);
    const p1 = before.platformAccountId;
    const adjustment = await adjustToPass(before, "challenge-a-phase1");
    const phase2 = await waitForChallenge(
      config.challengeAId,
      account =>
        String(account?.status || "").toUpperCase() === "PHASE_2"
        && Number(account?.currentPhase) === 2
        && account?.enabled === true
        && String(account?.platformAccountId || "") !== String(p1),
      "Challenge A Phase 2 activation",
    );
    state.phase2A = phase2.platformAccountId;

    const [oldRemote, newRemote] = await Promise.all([
      loadTraderAccount(p1),
      loadTraderAccount(state.phase2A),
    ]);
    assert.equal(String(oldRemote?.status || "").toUpperCase(), "DISABLED", "Superseded Phase 1 Trader account was not disabled.");
    assert.equal(String(newRemote?.status || "").toUpperCase(), "ACTIVE", "Phase 2 Trader account is not active.");
    assert.equal(newRemote?.tradingEnabled, true, "Phase 2 Trader account is not trading-enabled.");

    const oldRejected = await expectTradingRejected(p1, state.traderToken, "old-phase1");

    report.evidence.phase1ToPhase2 = {
      adjustment: adjustment.amount,
      oldPlatformAccountId: p1,
      newPlatformAccountId: state.phase2A,
      oldTraderStatus: oldRemote.status,
      newTraderStatus: newRemote.status,
      oldAccountTradingAttempt: oldRejected,
    };
    return { summary: "Phase 2 is a new account; Phase 1 was revoked and rejects new exposure." };
  });
  await abortIfLastScenarioFailed();

  await report.run("7. Breach racing a promotion wins and no active successor survives", async () => {
    const before = await loadChallenge(config.challengeBId);
    const p1 = before.platformAccountId;
    const adjustmentPromise = adjustToPass(before, "challenge-b-race");
    await sleep(config.raceBreachDelayMs);
    const breachPromise = traderInternal("/v1/internal/trading/accounts/" + p1 + "/breach", {
      method: "POST",
      body: { reason: "ACCEPTANCE_BREACH_DURING_PROMOTION", action: "LOCK_ONLY" },
      expected: 200,
    });
    const [adjustment, breach] = await Promise.all([adjustmentPromise, breachPromise]);

    const terminal = await waitForChallenge(
      config.challengeBId,
      account => String(account?.status || "").toUpperCase() === "BREACHED" && account?.enabled === false,
      "Challenge B terminal breach",
    );
    const activeSuccessors = activePlatformAccounts(terminal).filter(item => String(item.platformAccountId) !== String(p1));
    assert.equal(activeSuccessors.length, 0, "A successor account remained ACTIVE after the breach race.");
    assert.equal(terminal.commandPending, null, "A lifecycle promotion command remained pending after breach.");

    const remote = await loadTraderAccount(p1);
    assert.equal(String(remote?.status || "").toUpperCase(), "BREACHED", "Trader did not preserve BREACHED as terminal.");

    report.evidence.breachRace = {
      adjustment: adjustment.amount,
      breachOperation: breach.body?.operation || null,
      fundedStatus: terminal.status,
      commandPending: terminal.commandPending,
      traderStatus: remote.status,
      activeSuccessorCount: activeSuccessors.length,
    };
    return { summary: "Breach won the transition race; no active Phase 2 successor survived." };
  });
  await abortIfLastScenarioFailed();

  await report.run("8. Challenge A Phase 2 passes to non-tradable Funded Review", async () => {
    const before = await loadChallenge(config.challengeAId);
    assert.equal(String(before.status).toUpperCase(), "PHASE_2", "Challenge A is not in Phase 2.");
    const p2 = before.platformAccountId;
    const adjustment = await adjustToPass(before, "challenge-a-phase2");
    const review = await waitForChallenge(
      config.challengeAId,
      account => String(account?.status || "").toUpperCase() === "FUNDED_REVIEW" && account?.enabled === false,
      "Funded Review",
    );

    const launch = await fundedCustomer("/api/customer/accounts/" + encodeURIComponent(config.challengeAId) + "/trading-launch", {
      method: "POST",
      body: {},
    });
    assert.equal(launch.status, 409, "Funded Review account unexpectedly remained launchable.");

    const p2Remote = await loadTraderAccount(p2);
    assert.equal(String(p2Remote?.status || "").toUpperCase(), "DISABLED", "Completed Phase 2 Trader account was not disabled.");

    const sessionAccounts = await traderSession("/v1/auth/accounts", state.traderToken, { expected: 200 });
    const visibleMaster = (sessionAccounts.body?.accounts || []).find(item =>
      String(item?.accountType || "").toUpperCase() === "FUNDED"
      && String(item?.challenge?.fundedAccountId || "") === String(config.challengeAId)
    );
    assert.equal(Boolean(visibleMaster), false, "A Master account became federation-visible during Funded Review.");

    report.evidence.fundedReview = {
      adjustment: adjustment.amount,
      status: review.status,
      launchStatus: launch.status,
      phase2TraderStatus: p2Remote.status,
      visibleMaster: Boolean(visibleMaster),
    };
    return { summary: "Funded Review is non-tradable and exposes no Master account." };
  });
  await abortIfLastScenarioFailed();

  await report.run("9. Concurrent Master approval creates exactly one active Master", async () => {
    const path = "/api/admin/challenges/" + encodeURIComponent(config.challengeAId) + "/action";
    const body = { action: "APPROVE_FUNDED", reason: "Lifecycle acceptance double approval " + runId };
    const [left, right] = await Promise.all([
      fundedAdmin(path, { method: "POST", body }),
      fundedAdmin(path, { method: "POST", body }),
    ]);
    const successes = [left, right].filter(item => item.status === 200);
    const conflicts = [left, right].filter(item => item.status === 409);
    assert.equal(successes.length, 1, "Concurrent Master approval did not produce exactly one success.");
    assert.equal(conflicts.length, 1, "Concurrent Master approval did not produce exactly one conflict.");

    const funded = await waitForChallenge(
      config.challengeAId,
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

    report.evidence.masterApproval = {
      responseStatuses: [left.status, right.status],
      responseCodes: [left.body?.code || null, right.body?.code || null],
      masterPlatformAccountId: state.masterA,
      masterCount: masters.length,
      activeMasterCount: activeMasters.length,
      traderStatus: remote.status,
    };
    return { summary: "Double approval was serialized and produced one active Master." };
  });
  await abortIfLastScenarioFailed();

  await report.run("10. Master routing stays correct and reconciliation survives a restart hook", async () => {
    const masterSession = await exchangeLaunch(config.challengeAId);
    assert.equal(String(masterSession.launch?.selectedPlatformAccountId), String(state.masterA), "Funded launch did not select the Master account.");
    const routed = await tradeRoundTrip(state.masterA, masterSession.token, "master");

    let restart = { status: "SKIP", reason: "ACCEPTANCE_RESTART_HOOK_URL is not configured." };
    if (config.restartHookUrl) {
      const hook = await httpJson(config.restartHookUrl, "", {
        method: "POST",
        bearer: config.restartHookBearer || null,
        body: {
          runId,
          service: "funded-backend",
          reason: "lifecycle-acceptance-reconciliation",
        },
        expected: [200, 201, 202, 204],
        timeoutMs: 30000,
      });
      await poll(
        () => httpJson(config.fundedBaseUrl, "/health"),
        response => response.status === 200,
        { timeoutMs: config.timeoutMs, intervalMs: 1000, description: "Funded backend after restart hook" },
      );
      const after = await loadChallenge(config.challengeAId);
      const remote = await loadTraderAccount(state.masterA);
      assert.equal(String(after?.status || "").toUpperCase(), "FUNDED", "Master lifecycle changed after restart.");
      assert.equal(after?.enabled, true, "Master was disabled after restart.");
      assert.equal(String(remote?.status || "").toUpperCase(), "ACTIVE", "Trader Master was not ACTIVE after restart.");
      restart = { status: "PASS", hookStatus: hook.status, fundedStatus: after.status, traderStatus: remote.status };
    }

    report.evidence.masterRoutingAndRecovery = { routed, restart };
    if (restart.status === "SKIP") {
      return { status: "SKIP", summary: "Master routing passed; restart/reconciliation hook not configured.", routed, restart };
    }
    return { summary: "Master routing and post-restart reconciliation both passed.", routed, restart };
  });
}

report.finish({ requireAll: config.requireAll });
const files = await report.write(config.reportDir);
console.log(JSON.stringify({
  runId: report.runId,
  status: report.status,
  summary: report.summary,
  reports: files,
}, null, 2));

process.exitCode = report.status === "PASS" ? 0 : 1;
