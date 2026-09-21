import test from "node:test";
import assert from "node:assert/strict";
import {
  isAuthoritativeTraderSnapshot,
  isOlderThanLastAuthoritativeSnapshot,
  snapshotSequence,
  snapshotTime,
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
