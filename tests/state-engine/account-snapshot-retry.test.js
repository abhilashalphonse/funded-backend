import test from "node:test";
import assert from "node:assert/strict";

import { SnapshotProjectionScheduler } from "../../src/apis/services/accountSnapshot.service.js";

test("failed snapshot projections are retried without requiring a new snapshot", async () => {
  let attempts = 0;
  let resolveSuccess;
  const succeeded = new Promise(resolve => { resolveSuccess = resolve; });

  const scheduler = new SnapshotProjectionScheduler({
    concurrency: 1,
    retryDelayMs: 5,
    logger: { error() {} },
    project: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("queue unavailable");
      resolveSuccess();
    },
  });

  scheduler.enqueue({
    eventId: "acg-trader:snapshot-retry-1",
    aggregateId: "ACG-RETRY-1",
    occurredAt: new Date("2026-09-26T12:00:00.000Z"),
    payload: { valuationSequence: 1 },
  });

  await Promise.race([
    succeeded,
    new Promise((_, reject) => setTimeout(() => reject(new Error("snapshot retry timed out")), 250)),
  ]);

  assert.equal(attempts, 2);
  assert.equal(scheduler.health().failed, 1);
  assert.equal(scheduler.health().processed, 1);
  assert.equal(scheduler.health().retrying, 0);
});
