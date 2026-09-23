import test from "node:test";
import assert from "node:assert/strict";
import {
  isAuthoritativeTraderSnapshot,
  isOlderThanLastAuthoritativeSnapshot,
  snapshotSequence,
  snapshotTime,
  isEventForCurrentPlatformAccount,
  processEvent,
} from "../../src/workers/state-engine/processEvent.js";

const base = {
  eventType: "ACG_TRADER_ACCOUNT_SNAPSHOT",
  payload: { valuationStatus: "LIVE", complete: true },
};

test("live complete ACG Trader snapshot is authoritative for Funded risk decisions", () => {
  assert.equal(isAuthoritativeTraderSnapshot(base), true);
});

test("stale ACG Trader valuation cannot trigger Funded risk decisions", () => {
  assert.equal(isAuthoritativeTraderSnapshot({ ...base, payload: { valuationStatus: "STALE", complete: true } }), false);
});

test("incomplete ACG Trader valuation cannot trigger Funded risk decisions", () => {
  assert.equal(isAuthoritativeTraderSnapshot({ ...base, payload: { valuationStatus: "LIVE", complete: false } }), false);
});

test("non-snapshot provider events are not blocked by valuation authority guard", () => {
  assert.equal(isAuthoritativeTraderSnapshot({ eventType: "ACG_TRADER_DEAL_CREATED", payload: {} }), true);
});


test("older authoritative snapshots cannot overwrite newer Funded state", () => {
  const account = { lastPlatformSnapshotAt: new Date("2026-09-18T10:00:10.000Z") };
  const older = {
    eventType: "ACG_TRADER_ACCOUNT_SNAPSHOT",
    occurredAt: new Date("2026-09-18T10:00:09.000Z"),
    payload: { valuationStatus: "LIVE", complete: true },
  };
  const newer = {
    eventType: "ACG_TRADER_ACCOUNT_SNAPSHOT",
    occurredAt: new Date("2026-09-18T10:00:11.000Z"),
    payload: { valuationStatus: "LIVE", complete: true },
  };
  assert.equal(isOlderThanLastAuthoritativeSnapshot(account, older), true);
  assert.equal(isOlderThanLastAuthoritativeSnapshot(account, newer), false);
});

test("snapshot time prefers the platform occurrence time", () => {
  const event = {
    occurredAt: new Date("2026-09-18T10:00:00.000Z"),
    receivedAt: new Date("2026-09-18T10:01:00.000Z"),
  };
  assert.equal(snapshotTime(event).toISOString(), "2026-09-18T10:00:00.000Z");
});


test("same-millisecond Trader valuations use sequence as a tie-breaker", () => {
  const account = {
    lastPlatformSnapshotAt: new Date("2026-09-18T10:00:10.123Z"),
    lastPlatformSnapshotSequence: 42,
  };
  const olderSequence = {
    occurredAt: new Date("2026-09-18T10:00:10.123Z"),
    payload: { valuationSequence: 41 },
  };
  const sameSequence = {
    occurredAt: new Date("2026-09-18T10:00:10.123Z"),
    payload: { valuationSequence: 42 },
  };
  const newerSequence = {
    occurredAt: new Date("2026-09-18T10:00:10.123Z"),
    payload: { valuationSequence: 43 },
  };

  assert.equal(isOlderThanLastAuthoritativeSnapshot(account, olderSequence), true);
  assert.equal(isOlderThanLastAuthoritativeSnapshot(account, sameSequence), true);
  assert.equal(isOlderThanLastAuthoritativeSnapshot(account, newerSequence), false);
});

test("newer timestamp wins even when Trader sequence resets after restart", () => {
  const account = {
    lastPlatformSnapshotAt: new Date("2026-09-18T10:00:10.123Z"),
    lastPlatformSnapshotSequence: 900,
  };
  const afterRestart = {
    occurredAt: new Date("2026-09-18T10:00:11.000Z"),
    payload: { valuationSequence: 1 },
  };

  assert.equal(snapshotSequence(afterRestart), 1);
  assert.equal(isOlderThanLastAuthoritativeSnapshot(account, afterRestart), false);
});


test("missing Funded account is a terminal no-op for stale state events", async () => {
  let calls = 0;
  const accountModel = {
    async findOne() {
      calls += 1;
      return null;
    },
  };

  await assert.doesNotReject(() =>
    processEvent(
      {
        eventId: "acg-trader:stale-event",
        aggregateId: "TRIAL-DELETED",
        eventType: "ACG_TRADER_ACCOUNT_SNAPSHOT",
        payload: { complete: true, valuationStatus: "LIVE" },
      },
      null,
      { accountModel },
    )
  );

  assert.equal(calls, 1);
});


test("breached accounts reconcile authoritative post-liquidation metrics without changing breach state", async () => {
  const account = {
    status: "BREACHED",
    balance: 94792.62,
    equity: 94737.02,
    margin: 1250,
    marginFree: 93487.02,
    marginLevel: 0,
    floatingProfit: -55.6,
    lastPlatformSnapshotAt: new Date("2026-09-18T10:00:10.000Z"),
    lastPlatformSnapshotSequence: 42,
    lastProcessedEventId: null,
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
    },
  };
  const accountModel = {
    async findOne() {
      return account;
    },
  };
  const event = {
    eventId: "acg-trader:post-liquidation",
    aggregateId: "TRIAL-123",
    eventType: "ACG_TRADER_ACCOUNT_SNAPSHOT",
    occurredAt: new Date("2026-09-18T10:00:11.000Z"),
    payload: {
      complete: true,
      valuationStatus: "LIVE",
      valuationSequence: 43,
      balance: 94737.02,
      equity: 94737.02,
      margin: 0,
      marginFree: 94737.02,
      marginLevel: 0,
      floatingProfit: 0,
    },
  };

  await processEvent(event, null, { accountModel });

  assert.equal(account.status, "BREACHED");
  assert.equal(account.balance, 94737.02);
  assert.equal(account.equity, 94737.02);
  assert.equal(account.margin, 0);
  assert.equal(account.marginFree, 94737.02);
  assert.equal(account.floatingProfit, 0);
  assert.equal(account.lastPlatformSnapshotSequence, 43);
  assert.equal(account.lastProcessedEventId, event.eventId);
  assert.equal(account.saveCalls, 1);
});

test("breached accounts ignore stale post-liquidation snapshots", async () => {
  const account = {
    status: "BREACHED",
    balance: 94737.02,
    equity: 94737.02,
    margin: 0,
    marginFree: 94737.02,
    floatingProfit: 0,
    lastPlatformSnapshotAt: new Date("2026-09-18T10:00:11.000Z"),
    lastPlatformSnapshotSequence: 43,
    async save() {},
  };
  const accountModel = { async findOne() { return account; } };

  await processEvent({
    eventId: "acg-trader:stale-post-liquidation",
    aggregateId: "TRIAL-123",
    eventType: "ACG_TRADER_ACCOUNT_SNAPSHOT",
    occurredAt: new Date("2026-09-18T10:00:10.000Z"),
    payload: {
      complete: true,
      valuationStatus: "LIVE",
      valuationSequence: 42,
      balance: 94792.62,
      equity: 94737.02,
      margin: 1250,
      marginFree: 93487.02,
      floatingProfit: -55.6,
    },
  }, null, { accountModel });

  assert.equal(account.balance, 94737.02);
  assert.equal(account.floatingProfit, 0);
});


test("events from superseded Trader accounts cannot overwrite the current phase", async () => {
  const account = {
    status: "PHASE_2",
    platformAccountId: "phase-2",
    balance: 100000,
    lastProcessedEventId: null,
    saveCalls: 0,
    async save() { this.saveCalls += 1; },
  };
  const accountModel = { async findOne() { return account; } };
  const event = {
    eventId: "acg-trader:old-phase-snapshot",
    aggregateId: "ACG-123",
    eventType: "ACG_TRADER_ACCOUNT_SNAPSHOT",
    payload: {
      platformAccountId: "phase-1",
      complete: true,
      valuationStatus: "LIVE",
      balance: 109000,
      equity: 109000,
    },
  };

  assert.equal(isEventForCurrentPlatformAccount(account, event), false);
  await processEvent(event, null, { accountModel });

  assert.equal(account.balance, 100000);
  assert.equal(account.lastProcessedEventId, event.eventId);
  assert.equal(account.saveCalls, 1);
});

test("Master accounts keep accepting live valuation snapshots without challenge progression", async () => {
  const account = {
    status: "FUNDED",
    enabled: true,
    platformAccountId: "master-1",
    initialDeposit: 100000,
    accountSize: 100000,
    balance: 100000,
    equity: 100000,
    dailyStartEquity: 100000,
    projections: {
      highestBalance: 100000,
      highestEquity: 100000,
      profit: 0,
      dailyLoss: 0,
      totalLoss: 0,
      tradingDays: 0,
    },
    lastProcessedEventId: null,
    async save() {},
  };
  const accountModel = { async findOne() { return account; } };
  const event = {
    eventId: "acg-trader:master-live",
    aggregateId: "ACG-123",
    eventType: "ACG_TRADER_ACCOUNT_SNAPSHOT",
    occurredAt: new Date("2026-09-23T08:00:00.000Z"),
    payload: {
      platformAccountId: "master-1",
      complete: true,
      valuationStatus: "LIVE",
      valuationSequence: 55,
      balance: 101250,
      equity: 101100,
      margin: 500,
      marginFree: 100600,
      marginLevel: 20220,
      floatingProfit: -150,
      dailyStartEquity: 100500,
      riskDayKey: "2026-09-23",
    },
  };

  await processEvent(event, null, { accountModel });

  assert.equal(account.status, "FUNDED");
  assert.equal(account.enabled, true);
  assert.equal(account.balance, 101250);
  assert.equal(account.equity, 101100);
  assert.equal(account.floatingProfit, -150);
  assert.equal(account.projections.profit, 1250);
  assert.equal(account.projections.dailyLoss, 0);
  assert.equal(account.lastProcessedEventId, event.eventId);
});

test("current Master breach control event closes Funded-side trading state", async () => {
  const account = {
    status: "FUNDED",
    enabled: true,
    platformAccountId: "master-1",
    initialDeposit: 100000,
    accountSize: 100000,
    balance: 96000,
    equity: 95500,
    dailyStartEquity: 99500,
    projections: { dailyLoss: 4000, totalLoss: 4500, profit: -4000, tradingDays: 2 },
    rules: { dailyDrawdown: 3, maxDrawdown: 6 },
    platformAccounts: [{ phase: 2, accountType: "FUNDED", platformAccountId: "master-1", status: "ACTIVE" }],
    breach: null,
    lastProcessedEventId: null,
    async save() {},
  };
  const accountModel = { async findOne() { return account; } };
  const event = {
    eventId: "acg-trader:master-breach",
    aggregateId: "ACG-123",
    eventType: "ACG_TRADER_ACCOUNT_CONTROLLED",
    timestamp: "2026-09-23T08:05:00.000Z",
    payload: {
      platformAccountId: "master-1",
      status: "BREACHED",
      tradingEnabled: false,
      reason: "MAX_LOSS_LIMIT_REACHED",
      breachedAt: "2026-09-23T08:04:59.000Z",
      balance: "94000",
      equity: "93800",
      floatingProfit: "-200",
      margin: "0",
      marginFree: "93800",
      dailyStartEquity: "99000",
      riskDayKey: "2026-09-23",
      sourceEvent: "trading.account.breached",
    },
  };

  await processEvent(event, null, { accountModel });

  assert.equal(account.status, "BREACHED");
  assert.equal(account.enabled, false);
  assert.equal(account.platformAccounts[0].status, "BREACHED");
  assert.equal(account.balance, 94000);
  assert.equal(account.equity, 93800);
  assert.equal(account.projections.profit, -6000);
  assert.equal(account.projections.totalLoss, 6200);
  assert.equal(account.projections.dailyLoss, 5200);
  assert.equal(account.breach.primaryReason, "MAX_DRAWDOWN");
  assert.equal(account.breach.balance, 94000);
  assert.equal(account.breach.equity, 93800);
  assert.equal(account.breach.actualLoss, 6200);
  assert.equal(account.breach.breachAmount, 200);
  assert.equal(account.breach.breachedAt.toISOString(), "2026-09-23T08:04:59.000Z");
  assert.equal(account.lastProcessedEventId, event.eventId);
});
