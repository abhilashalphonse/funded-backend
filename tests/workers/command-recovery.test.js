import test from "node:test";
import assert from "node:assert/strict";

import { CommandWorker } from "../../src/workers/command-worker.js";
import { COMMAND_QUEUE_NAME, CommandQueue } from "../../src/workers/state-engine/commandQueue.js";

function pendingQuery(rows) {
  return {
    select() { return this; },
    limit() { return this; },
    async lean() { return rows; },
  };
}

test("lifecycle command enqueue is idempotent per account and command", async () => {
  const calls = [];
  const boss = {
    async sendOnce(name, data, options, key) {
      calls.push({ name, data, options, key });
      return "job-1";
    },
  };

  const queue = new CommandQueue(boss);
  const jobId = await queue.enqueueCommand("CREATE_PHASE_2_ACCOUNT", {
    accountId: "ACG-100",
    balance: 110000,
    equity: 110000,
    status: "PASSED",
  });

  assert.equal(jobId, "job-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, COMMAND_QUEUE_NAME);
  assert.equal(calls[0].key, "ACG-100:CREATE_PHASE_2_ACCOUNT");
});

test("durable commandPending work is retried after a queue outage while the process stays up", async () => {
  const rows = [{ accountId: "ACG-RETRY-2", commandPending: "ENTER_FUNDED_REVIEW" }];
  const accountModel = {
    find() { return pendingQuery(rows); },
  };

  let attempts = 0;
  const boss = {
    async sendOnce() {
      attempts += 1;
      if (attempts === 1) throw new Error("pg-boss unavailable");
      return "job-recovered";
    },
  };

  const errors = [];
  const worker = new CommandWorker(boss, {
    accountModel,
    recoveryIntervalMs: 10,
    logger: { error(...args) { errors.push(args); } },
  });

  const first = await worker.recoverPendingCommands();
  assert.equal(first.scanned, 1);
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);

  const second = await worker.recoverPendingCommands();
  assert.equal(second.scanned, 1);
  assert.equal(attempts, 2);
});

test("command worker installs and can stop the periodic pending-command recovery loop", async () => {
  const accountModel = {
    find() { return pendingQuery([]); },
    async updateOne() {},
  };
  const boss = {
    async work() { return "worker-id"; },
    async sendOnce() { return null; },
  };

  const worker = new CommandWorker(boss, {
    accountModel,
    recoveryIntervalMs: 1000,
    logger: { error() {} },
  });

  await worker.start();
  assert.ok(worker.recoveryTimer);

  worker.stop();
  assert.equal(worker.recoveryTimer, null);
});
