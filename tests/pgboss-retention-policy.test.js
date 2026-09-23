import test from "node:test";
import assert from "node:assert/strict";
import { PG_BOSS_QUEUE_NAMES, PG_BOSS_QUEUE_POLICIES } from "../src/config/pgbossQueues.js";

test("pg-boss launch queues all have bounded retention", () => {
  assert.deepEqual(
    [...PG_BOSS_QUEUE_NAMES].sort(),
    [
      "account-commands",
      "challenge-activation-email",
      "incoming-events",
      "payment-activation",
      "state-events",
      "trading-credential-email",
    ].sort(),
  );

  for (const queueName of PG_BOSS_QUEUE_NAMES) {
    const policy = PG_BOSS_QUEUE_POLICIES[queueName];
    assert.ok(policy.retentionSeconds > 0, `${queueName} retention must be positive`);
    assert.ok(policy.deleteAfterSeconds > 0, `${queueName} completion retention must be bounded`);
    assert.ok(
      policy.deleteAfterSeconds <= policy.retentionSeconds,
      `${queueName} completed jobs should not outlive queued/retry retention`,
    );
  }
});

test("high-volume event queues expire completed transport jobs within six hours", () => {
  assert.equal(PG_BOSS_QUEUE_POLICIES["incoming-events"].deleteAfterSeconds, 6 * 60 * 60);
  assert.equal(PG_BOSS_QUEUE_POLICIES["state-events"].deleteAfterSeconds, 6 * 60 * 60);
});
