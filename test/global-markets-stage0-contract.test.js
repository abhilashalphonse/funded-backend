import test from "node:test";
import assert from "node:assert/strict";

import { evaluateRules } from "../src/workers/state-engine/rules.js";
import {
  isAuthoritativeTraderSnapshot,
  isOlderThanLastAuthoritativeSnapshot,
  snapshotEpoch,
  snapshotFinancialRevision,
} from "../src/workers/state-engine/processEvent.js";

function baseAccount() {
  return {
    accountId: "acct-1",
    initialDeposit: 100000,
    currentPhase: 1,
    rules: {
      dailyDrawdown: 5,
      maxDrawdown: 5,
      minimumTradingDays: 0,
      phases: [{ phase: 1, profitTarget: 8 }],
    },
    projections: {
      dailyLoss: 5000,
      totalLoss: 5000,
      tradingDays: 0,
    },
    balance: 95000,
    equity: 95000,
  };
}

test("GM-003 Funded does not round a sub-cent safe equity into a breach", () => {
  const account = baseAccount();
  account.platformFinancial = {
    contractVersion: 1,
    accountCurrency: "USD",
    initialBalance: "100000",
    balance: "95000.000000000001",
    equity: "95000.000000000001",
    dailyStartEquity: "100000",
  };

  const result = evaluateRules(account);

  assert.equal(result.dailyLossBreached, false);
  assert.equal(result.maxLossBreached, false);
});

test("GM-003 exact decimal boundary still breaches at the configured floor", () => {
  const account = baseAccount();
  account.platformFinancial = {
    contractVersion: 1,
    accountCurrency: "USD",
    initialBalance: "100000",
    balance: "95000",
    equity: "95000",
    dailyStartEquity: "100000",
  };

  const result = evaluateRules(account);

  assert.equal(result.dailyLossBreached, true);
  assert.equal(result.maxLossBreached, true);
});

test("GM-003 sequence tie-breaker is not compared across Trader restart epochs", () => {
  const account = {
    lastPlatformSnapshotAt: new Date("2026-10-07T00:00:00.000Z"),
    lastPlatformSnapshotSequence: 900,
    lastPlatformSnapshotEpoch: "old-epoch",
    lastPlatformFinancialRevision: 8,
  };
  const event = {
    eventType: "ACG_TRADER_ACCOUNT_SNAPSHOT",
    occurredAt: "2026-10-07T00:00:00.000Z",
    payload: {
      valuationEpoch: "new-epoch",
      valuationSequence: 1,
      financialRevision: 8,
    },
  };

  assert.equal(snapshotEpoch(event), "new-epoch");
  assert.equal(snapshotFinancialRevision(event), 8);
  assert.equal(isOlderThanLastAuthoritativeSnapshot(account, event), false);
});

test("GM-003 lower financial revision is rejected at the same timestamp across epochs", () => {
  const account = {
    lastPlatformSnapshotAt: new Date("2026-10-07T00:00:00.000Z"),
    lastPlatformSnapshotSequence: 12,
    lastPlatformSnapshotEpoch: "newer",
    lastPlatformFinancialRevision: 9,
  };
  const event = {
    eventType: "ACG_TRADER_ACCOUNT_SNAPSHOT",
    occurredAt: "2026-10-07T00:00:00.000Z",
    payload: {
      valuationEpoch: "older",
      valuationSequence: 999,
      financialRevision: 8,
    },
  };

  assert.equal(isOlderThanLastAuthoritativeSnapshot(account, event), true);
});


test("GM-003 malformed v1 financial contract is not authoritative", () => {
  const event = {
    eventType: "ACG_TRADER_ACCOUNT_SNAPSHOT",
    payload: {
      financialContractVersion: 1,
      complete: true,
      valuationStatus: "LIVE",
      accountCurrency: "USD",
      initialBalance: "100000",
      balance: "95000",
      equity: "not-a-decimal",
      dailyStartEquity: "100000",
      financialRevision: 3,
      valuationEpoch: "epoch-1",
      valuationSequence: 7,
      valuedAtMs: 1791331200000,
    },
  };

  assert.equal(isAuthoritativeTraderSnapshot(event), false);
});

test("GM-003 valid v1 financial contract is authoritative", () => {
  const event = {
    eventType: "ACG_TRADER_ACCOUNT_SNAPSHOT",
    payload: {
      financialContractVersion: 1,
      complete: true,
      valuationStatus: "LIVE",
      accountCurrency: "USD",
      initialBalance: "100000",
      balance: "95000.000000000001",
      equity: "95000.000000000001",
      dailyStartEquity: "100000",
      financialRevision: 3,
      valuationEpoch: "epoch-1",
      valuationSequence: 7,
      valuedAtMs: 1791331200000,
    },
  };

  assert.equal(isAuthoritativeTraderSnapshot(event), true);
});
