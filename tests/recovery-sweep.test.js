import test from "node:test";
import assert from "node:assert/strict";
import { recoverPages, periodicRecovery } from "../src/workers/recovery-sweep.js";

test("recovery traverses more than 500 records and continues after enqueue failure", async () => {
  const ids = Array.from({ length: 1201 }, (_, i) => String(i).padStart(6, "0"));
  const attempted = [];
  const failures = [];
  const model = { find: filter => ({ select() { return this; }, sort() { return this; }, limit(n) { this.n = n; return this; },
    lean() { assert.ok(filter.createdAt.$lte instanceof Date); return ids.filter(id => !filter._id || id > filter._id.$gt).slice(0, this.n).map(_id => ({ _id })); },
  }) };
  const count = await recoverPages({ model, filter: { status: "PAID" }, enqueue: async id => {
    attempted.push(id); if (id === ids[1]) throw new Error("queue failure");
  }, onError: (error, id) => failures.push(id) });
  assert.equal(count, 1201);
  assert.deepEqual(attempted, ids);
  assert.deepEqual(failures, [ids[1]]);
});

test("periodic recovery repeats and never overlaps slow passes", async () => {
  let active = 0;
  let runs = 0;
  const recovery = periodicRecovery(async () => {
    assert.equal(active, 0); active++; runs++;
    await new Promise(resolve => setTimeout(resolve, 8)); active--;
  }, error => { throw error; }, 5);
  try {
    await recovery.tick();
    await new Promise(resolve => setTimeout(resolve, 35));
  } finally { await recovery.stop(); }
  assert.ok(runs >= 2);
  assert.equal(active, 0);
});
