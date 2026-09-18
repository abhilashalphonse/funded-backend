import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { evaluateRules } from "../src/workers/state-engine/rules.js";
import { resolveDecision } from "../src/workers/state-engine/decisions.js";
import { resetAccountForPhaseTwo, isActivePhaseTwo } from "../src/workers/command-worker.js";
import { shouldReplayPendingCommand } from "../src/workers/state-engine/processEvent.js";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const traderRepo = path.resolve(here, "..", process.env.ACG_TRADER_REPO_PATH || "acg-trader-backend");

const {
  validateChallengeRiskForOpen,
} = require(path.join(traderRepo, "src/modules/trading/execution-planner.js"));
const {
  assertProvisionReplay,
} = require(path.join(traderRepo, "src/modules/trading/account-control.service.js"));
const {
  RiskDayEngine,
} = require(path.join(traderRepo, "src/modules/trading/risk-day-engine.js"));

function fundedAccount(overrides = {}) {
  return {
    accountId: "E2E-100K",
    challengeType: "TWO_STEP",
    currentPhase: 1,
    status: "ACTIVE",
    enabled: true,
    accountSize: 100000,
    initialDeposit: 100000,
    rules: {
      dailyDrawdown: 3,
      maxDrawdown: 6,
      minimumTradingDays: 5,
      phases: [
        { phase: 1, profitTarget: 10 },
        { phase: 2, profitTarget: 8 },
      ],
    },
    projections: {
      profit: 0,
      dailyLoss: 0,
      totalLoss: 0,
      tradingDays: 0,
    },
    platformAccounts: [
      { phase: 1, platformAccountId: "64b000000000000000000001", status: "ACTIVE" },
    ],
    ...overrides,
  };
}

function traderAccount(overrides = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    status: "ACTIVE",
    tradingEnabled: true,
    riskDayKey: today,
    state: {
      initialBalance: "100000",
      balance: "100000",
      equity: "100000",
      dailyStartEquity: "100000",
      realizedPnlToday: "0",
      ...overrides.state,
    },
    riskPolicy: {
      dailyLoss: { limit: "3000", reference: "DAILY_START_EQUITY" },
      maxLoss: { limit: "6000", reference: "INITIAL_BALANCE" },
      profitTarget: "10000",
      allowedSymbols: [],
      ...overrides.riskPolicy,
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !["state", "riskPolicy"].includes(key))),
  };
}

test("01 below daily loss limit remains ACTIVE and ACG Trader accepts exposure", () => {
  const account = fundedAccount({
    projections: { profit: -2999, dailyLoss: 2999, totalLoss: 2999, tradingDays: 1 },
  });
  const rules = evaluateRules(account);
  assert.equal(rules.dailyLossBreached, false);
  assert.equal(rules.maxLossBreached, false);
  assert.deepEqual(resolveDecision(account, rules), {
    shouldUpdate: false,
    newStatus: "ACTIVE",
    command: null,
  });

  assert.doesNotThrow(() => validateChallengeRiskForOpen(
    traderAccount({ state: { equity: "97001", balance: "97001" } }),
  ));
});

test("02 crossing daily loss breaches Funded and rejects new Trader exposure", () => {
  const account = fundedAccount({
    projections: { profit: -3000, dailyLoss: 3000, totalLoss: 3000, tradingDays: 1 },
  });
  const rules = evaluateRules(account);
  assert.equal(rules.dailyLossBreached, true);
  assert.deepEqual(resolveDecision(account, rules), {
    shouldUpdate: true,
    newStatus: "BREACHED",
    command: "LOCK_ACCOUNT",
  });

  assert.throws(
    () => validateChallengeRiskForOpen(traderAccount({ state: { equity: "97000", balance: "97000" } })),
    error => error.code === "DAILY_LOSS_LIMIT_REACHED",
  );
});

test("03 crossing maximum loss breaches Funded and rejects new Trader exposure", () => {
  const account = fundedAccount({
    projections: { profit: -6000, dailyLoss: 1000, totalLoss: 6000, tradingDays: 1 },
  });
  const rules = evaluateRules(account);
  assert.equal(rules.maxLossBreached, true);
  assert.deepEqual(resolveDecision(account, rules), {
    shouldUpdate: true,
    newStatus: "BREACHED",
    command: "LOCK_ACCOUNT",
  });

  assert.throws(
    () => validateChallengeRiskForOpen(traderAccount({
      state: { dailyStartEquity: "95000", equity: "94000", balance: "94000" },
    })),
    error => error.code === "MAX_LOSS_LIMIT_REACHED",
  );
});

test("04 profit target before minimum trading days does not pass challenge", () => {
  const account = fundedAccount({
    projections: { profit: 10000, dailyLoss: 0, totalLoss: 0, tradingDays: 4 },
  });
  const rules = evaluateRules(account);
  assert.equal(rules.profitTargetHit, true);
  assert.equal(rules.minimumDaysMet, false);
  assert.deepEqual(resolveDecision(account, rules), {
    shouldUpdate: false,
    newStatus: "ACTIVE",
    command: null,
  });
});

test("05 Phase 1 target plus minimum days transitions to Phase 2 command", () => {
  const account = fundedAccount({
    projections: { profit: 10000, dailyLoss: 0, totalLoss: 0, tradingDays: 5 },
  });
  assert.deepEqual(resolveDecision(account, evaluateRules(account)), {
    shouldUpdate: true,
    newStatus: "PASSED",
    command: "CREATE_PHASE_2_ACCOUNT",
  });
});

test("06 Phase 2 begins with a clean evaluation state", () => {
  const account = fundedAccount({
    status: "PASSED",
    balance: 110000,
    equity: 111000,
    margin: 1200,
    marginFree: 109800,
    floatingProfit: 1000,
    dailyStartEquity: 108000,
    totalTrades: 37,
    winningTrades: 22,
    losingTrades: 15,
    lastTradingDay: "2026-09-18",
    riskDayKey: "2026-09-18",
    projections: {
      highestBalance: 110000,
      highestEquity: 111000,
      profit: 10000,
      dailyLoss: 250,
      totalLoss: 0,
      tradingDays: 5,
    },
  });

  resetAccountForPhaseTwo(account, new Date("2026-09-18T12:00:00Z"));

  assert.equal(account.currentPhase, 2);
  assert.equal(account.status, "PHASE_2");
  assert.equal(account.balance, 100000);
  assert.equal(account.equity, 100000);
  assert.equal(account.totalTrades, 0);
  assert.equal(account.projections.profit, 0);
  assert.equal(account.projections.dailyLoss, 0);
  assert.equal(account.projections.totalLoss, 0);
  assert.equal(account.projections.tradingDays, 0);
  assert.equal(account.lastTradingDay, null);
});

test("07 final-phase target transitions to FUNDED_REVIEW and pauses exposure", () => {
  const account = fundedAccount({
    currentPhase: 2,
    status: "PHASE_2",
    projections: { profit: 8000, dailyLoss: 0, totalLoss: 0, tradingDays: 5 },
  });

  assert.deepEqual(resolveDecision(account, evaluateRules(account)), {
    shouldUpdate: true,
    newStatus: "FUNDED_REVIEW",
    command: "ENTER_FUNDED_REVIEW",
  });

  assert.throws(
    () => validateChallengeRiskForOpen(traderAccount({
      state: { balance: "108000", equity: "108000" },
      riskPolicy: { profitTarget: "8000" },
    })),
    error => error.code === "PROFIT_TARGET_REACHED",
  );
});

test("08 restart/retry preserves pending lifecycle command and Trader provisioning idempotency", () => {
  const event = { eventId: "evt-phase2" };
  const account = {
    lastProcessedEventId: "evt-phase2",
    commandPending: "CREATE_PHASE_2_ACCOUNT",
  };
  assert.equal(shouldReplayPendingCommand(account, event), true);

  const provisioned = {
    tenantId: "64b0000000000000000000aa",
    ownerExternalRef: "user-123",
    userId: null,
    accountType: "CHALLENGE",
    currency: "USD",
    leverage: 100,
    accountCode: "ACG-E2E",
    state: { initialBalance: "100000" },
  };
  const replayInput = {
    tenantId: "64b0000000000000000000aa",
    ownerExternalRef: "user-123",
    userId: null,
    accountType: "CHALLENGE",
    currency: "USD",
    leverage: 100,
    accountCode: "ACG-E2E",
    initialBalance: "100000",
  };
  assert.equal(assertProvisionReplay(provisioned, replayInput), provisioned);
});

test("09 duplicate snapshots/commands cannot create or reset a second Phase 2", () => {
  const alreadyPassed = fundedAccount({ status: "PASSED" });
  assert.deepEqual(resolveDecision(alreadyPassed, {
    dailyLossBreached: false,
    maxLossBreached: false,
    profitTargetHit: true,
    minimumDaysMet: true,
  }), {
    shouldUpdate: false,
    newStatus: "PASSED",
    command: null,
  });

  const activePhaseTwo = fundedAccount({
    currentPhase: 2,
    status: "PHASE_2",
    platformAccounts: [
      { phase: 1, platformAccountId: "p1", status: "COMPLETED" },
      { phase: 2, platformAccountId: "p2", status: "ACTIVE" },
    ],
  });
  assert.equal(isActivePhaseTwo(activePhaseTwo), true);
});

test("10 UTC midnight resets live daily baseline and Funded evaluates from the new baseline", async () => {
  const eventBus = new (await import("node:events")).EventEmitter();
  const doc = {
    _id: "64b000000000000000000001",
    riskDayKey: "2026-09-17",
    state: {
      initialBalance: "100000",
      balance: "99000",
      equity: "99000",
      floatingPnl: "0",
      realizedPnlToday: "-1000",
      usedMargin: "0",
      freeMargin: "99000",
      dailyStartEquity: "100000",
    },
    riskPolicy: {},
    metadata: {},
    accountCode: "ACG-E2E",
    accountType: "CHALLENGE",
    currency: "USD",
    leverage: 100,
    status: "ACTIVE",
    tradingEnabled: true,
    async save() { this.saved = true; },
    toObject() {
      return {
        _id: this._id,
        riskDayKey: this.riskDayKey,
        state: this.state,
        riskPolicy: this.riskPolicy,
        metadata: this.metadata,
        accountCode: this.accountCode,
        accountType: this.accountType,
        currency: this.currency,
        leverage: this.leverage,
        status: this.status,
        tradingEnabled: this.tradingEnabled,
      };
    },
  };

  const engine = new RiskDayEngine({
    eventBus,
    accountModel: { findById: async () => doc },
    now: () => new Date("2026-09-18T00:00:01Z"),
  });
  engine.start();
  eventBus.emit("valuation.account.updated", {
    accountId: doc._id,
    complete: true,
    valuationStatus: "LIVE",
    equity: "99000",
  });
  await new Promise(resolve => setImmediate(resolve));
  engine.stop();

  assert.equal(doc.riskDayKey, "2026-09-18");
  assert.equal(String(doc.state.dailyStartEquity), "99000");
  assert.equal(String(doc.state.realizedPnlToday), "0");

  const funded = fundedAccount({
    dailyStartEquity: 99000,
    equity: 98500,
    balance: 99000,
    projections: { profit: -1000, dailyLoss: 500, totalLoss: 1500, tradingDays: 2 },
  });
  const rules = evaluateRules(funded);
  assert.equal(rules.dailyLossBreached, false);
  assert.equal(rules.maxLossBreached, false);
});
