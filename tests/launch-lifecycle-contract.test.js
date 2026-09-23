import test from "node:test";
import assert from "node:assert/strict";

import { evaluateRules } from "../src/workers/state-engine/rules.js";
import { resolveDecision } from "../src/workers/state-engine/decisions.js";
import { resetAccountForPhaseTwo, isActivePhaseTwo, phaseAccountType } from "../src/workers/command-worker.js";
import { buildBreachRecord, shouldReplayPendingCommand } from "../src/workers/state-engine/processEvent.js";

function account(overrides = {}) {
  const projections = overrides.projections || {
    profit: 0,
    dailyLoss: 0,
    totalLoss: 0,
    tradingDays: 0,
  };
  const initialDeposit = Number(overrides.initialDeposit || 100000);
  const balance = overrides.balance ?? initialDeposit + Number(projections.profit || 0);
  const equity = overrides.equity ?? balance;

  return {
    accountId: "E2E-100K",
    challengeType: "TWO_STEP",
    currentPhase: 1,
    status: "ACTIVE",
    enabled: true,
    accountSize: 100000,
    initialDeposit,
    balance,
    equity,
    rules: {
      dailyDrawdown: 3,
      maxDrawdown: 6,
      minimumTradingDays: 5,
      phases: [
        { phase: 1, profitTarget: 10 },
        { phase: 2, profitTarget: 8 },
      ],
    },
    projections,
    platformAccounts: [
      { phase: 1, platformAccountId: "p1", status: "ACTIVE" },
    ],
    ...overrides,
  };
}

test("01 below daily loss limit remains active", () => {
  const a = account({ projections: { profit: -2999, dailyLoss: 2999, totalLoss: 2999, tradingDays: 1 } });
  const rules = evaluateRules(a);
  assert.equal(rules.dailyLossBreached, false);
  assert.equal(rules.maxLossBreached, false);
  assert.deepEqual(resolveDecision(a, rules), { shouldUpdate: false, newStatus: "ACTIVE", command: null });
});

test("02 crossing daily loss transitions to breach lock command", () => {
  const a = account({ projections: { profit: -3000, dailyLoss: 3000, totalLoss: 3000, tradingDays: 1 } });
  assert.deepEqual(resolveDecision(a, evaluateRules(a)), {
    shouldUpdate: true,
    newStatus: "BREACHED",
    command: "LOCK_ACCOUNT",
    primaryReason: "DAILY_DRAWDOWN",
    triggeredRules: ["DAILY_DRAWDOWN"],
  });
});

test("03 crossing maximum loss transitions to breach lock command", () => {
  const a = account({ projections: { profit: -6000, dailyLoss: 1000, totalLoss: 6000, tradingDays: 1 } });
  assert.deepEqual(resolveDecision(a, evaluateRules(a)), {
    shouldUpdate: true,
    newStatus: "BREACHED",
    command: "LOCK_ACCOUNT",
    primaryReason: "MAX_DRAWDOWN",
    triggeredRules: ["MAX_DRAWDOWN"],
  });
});

test("04 target before minimum trading days does not pass", () => {
  const a = account({ projections: { profit: 10000, dailyLoss: 0, totalLoss: 0, tradingDays: 4 } });
  const rules = evaluateRules(a);
  assert.equal(rules.profitTargetHit, true);
  assert.equal(rules.minimumDaysMet, false);
  assert.deepEqual(resolveDecision(a, rules), { shouldUpdate: false, newStatus: "ACTIVE", command: null });
});

test("05 Phase 1 target plus minimum days requests Phase 2", () => {
  const a = account({ projections: { profit: 10000, dailyLoss: 0, totalLoss: 0, tradingDays: 5 } });
  assert.deepEqual(resolveDecision(a, evaluateRules(a)), {
    shouldUpdate: true,
    newStatus: "PASSED",
    command: "CREATE_PHASE_2_ACCOUNT",
  });
});

test("06 Phase 2 reset clears all Phase 1 evaluation progress", () => {
  const a = account({
    status: "PASSED",
    balance: 110000,
    equity: 111000,
    margin: 1200,
    marginFree: 109800,
    floatingProfit: 1000,
    dailyStartEquity: 108000,
    riskDayKey: "2026-09-18",
    lastTradingDay: "2026-09-18",
    totalTrades: 37,
    winningTrades: 22,
    losingTrades: 15,
    projections: {
      highestBalance: 110000,
      highestEquity: 111000,
      profit: 10000,
      dailyLoss: 250,
      totalLoss: 0,
      tradingDays: 5,
    },
  });

  resetAccountForPhaseTwo(a, new Date("2026-09-18T12:00:00Z"));

  assert.equal(a.currentPhase, 2);
  assert.equal(a.status, "PHASE_2");
  assert.equal(a.balance, 100000);
  assert.equal(a.equity, 100000);
  assert.equal(a.totalTrades, 0);
  assert.equal(a.winningTrades, 0);
  assert.equal(a.losingTrades, 0);
  assert.equal(a.projections.profit, 0);
  assert.equal(a.projections.dailyLoss, 0);
  assert.equal(a.projections.totalLoss, 0);
  assert.equal(a.projections.tradingDays, 0);
  assert.equal(a.lastTradingDay, null);
});

test("07 final-phase target plus minimum days enters funded review", () => {
  const a = account({
    currentPhase: 2,
    status: "PHASE_2",
    projections: { profit: 8000, dailyLoss: 0, totalLoss: 0, tradingDays: 5 },
  });
  assert.deepEqual(resolveDecision(a, evaluateRules(a)), {
    shouldUpdate: true,
    newStatus: "FUNDED_REVIEW",
    command: "ENTER_FUNDED_REVIEW",
  });
});

test("08 restart/retry replays a pending lifecycle command", () => {
  assert.equal(
    shouldReplayPendingCommand(
      { lastProcessedEventId: "evt-1", commandPending: "CREATE_PHASE_2_ACCOUNT" },
      { eventId: "evt-1" },
    ),
    true,
  );
});

test("09 duplicate snapshots and commands do not re-transition Phase 2", () => {
  const passed = account({ status: "PASSED" });
  assert.deepEqual(resolveDecision(passed, {
    dailyLossBreached: false,
    maxLossBreached: false,
    profitTargetHit: true,
    minimumDaysMet: true,
  }), {
    shouldUpdate: false,
    newStatus: "PASSED",
    command: null,
  });

  assert.equal(isActivePhaseTwo(account({
    currentPhase: 2,
    status: "PHASE_2",
    platformAccounts: [
      { phase: 1, platformAccountId: "p1", status: "COMPLETED" },
      { phase: 2, platformAccountId: "p2", status: "ACTIVE" },
    ],
  })), true);
});

test("10 new UTC-day baseline is evaluated independently from prior-day loss", () => {
  const a = account({
    dailyStartEquity: 99000,
    balance: 99000,
    equity: 98500,
    projections: { profit: -1000, dailyLoss: 500, totalLoss: 1500, tradingDays: 2 },
  });
  const rules = evaluateRules(a);
  assert.equal(rules.dailyLossBreached, false);
  assert.equal(rules.maxLossBreached, false);
});

test("11 manually locked account remains terminal even if target conditions are met", () => {
  const a = account({
    status: "LOCKED",
    projections: { profit: 12000, dailyLoss: 0, totalLoss: 0, tradingDays: 5 },
  });
  assert.deepEqual(resolveDecision(a, evaluateRules(a)), {
    shouldUpdate: false,
    newStatus: "LOCKED",
    command: null,
  });
});


test("12 simultaneous daily and maximum loss breach records both rules with max loss as primary", () => {
  const a = account({ projections: { profit: -7000, dailyLoss: 3500, totalLoss: 7000, tradingDays: 1 } });
  assert.deepEqual(resolveDecision(a, evaluateRules(a)), {
    shouldUpdate: true,
    newStatus: "BREACHED",
    command: "LOCK_ACCOUNT",
    primaryReason: "MAX_DRAWDOWN",
    triggeredRules: ["DAILY_DRAWDOWN", "MAX_DRAWDOWN"],
  });
});

test("13 breach snapshot freezes the triggering valuation and limit", () => {
  const a = account({
    currentPhase: 1,
    balance: 90500,
    equity: 89750,
    dailyStartEquity: 93000,
    projections: {
      profit: -9500,
      dailyLoss: 3250,
      totalLoss: 10250,
      tradingDays: 2,
    },
  });
  const decision = resolveDecision(a, evaluateRules(a));
  const event = {
    occurredAt: new Date("2026-09-21T03:04:05.678Z"),
  };

  const breach = buildBreachRecord(a, decision, event);

  assert.equal(breach.primaryReason, "MAX_DRAWDOWN");
  assert.deepEqual(breach.triggeredRules, ["DAILY_DRAWDOWN", "MAX_DRAWDOWN"]);
  assert.equal(breach.breachedAt.toISOString(), "2026-09-21T03:04:05.678Z");
  assert.equal(breach.phase, 1);
  assert.equal(breach.balance, 90500);
  assert.equal(breach.equity, 89750);
  assert.equal(breach.dailyStartEquity, 93000);
  assert.equal(breach.initialBalance, 100000);
  assert.equal(breach.dailyLoss, 3250);
  assert.equal(breach.totalLoss, 10250);
  assert.equal(breach.limitAmount, 6000);
  assert.equal(breach.actualLoss, 10250);
  assert.equal(breach.breachAmount, 4250);
});

test("14 one-step free trial completes as PASSED instead of funded review", () => {
  const a = account({
    accountMode: "DEMO",
    challengeType: "ONE_STEP",
    currentPhase: 1,
    rules: {
      dailyDrawdown: 3,
      maxDrawdown: 6,
      minimumTradingDays: 5,
      phases: [{ phase: 1, profitTarget: 10 }],
    },
    projections: { profit: 10000, dailyLoss: 0, totalLoss: 0, tradingDays: 5 },
  });

  assert.deepEqual(resolveDecision(a, evaluateRules(a)), {
    shouldUpdate: true,
    newStatus: "PASSED",
    command: "COMPLETE_TRIAL",
  });
});

test("15 two-step free trial Phase 1 stays DEMO and requests Phase 2", () => {
  const a = account({
    accountMode: "DEMO",
    projections: { profit: 10000, dailyLoss: 0, totalLoss: 0, tradingDays: 5 },
  });

  assert.equal(phaseAccountType(a), "DEMO");
  assert.deepEqual(resolveDecision(a, evaluateRules(a)), {
    shouldUpdate: true,
    newStatus: "PASSED",
    command: "CREATE_PHASE_2_ACCOUNT",
  });
});

test("16 two-step free trial final phase completes instead of funded review", () => {
  const a = account({
    accountMode: "DEMO",
    currentPhase: 2,
    status: "PHASE_2",
    projections: { profit: 8000, dailyLoss: 0, totalLoss: 0, tradingDays: 5 },
  });

  assert.deepEqual(resolveDecision(a, evaluateRules(a)), {
    shouldUpdate: true,
    newStatus: "PASSED",
    command: "COMPLETE_TRIAL",
  });
});

test("17 paid Phase 2 provisioning remains CHALLENGE", () => {
  assert.equal(phaseAccountType(account({ accountMode: "CHALLENGE" })), "CHALLENGE");
});

