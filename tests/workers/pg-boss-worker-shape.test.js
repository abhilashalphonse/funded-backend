import test from "node:test";
import assert from "node:assert/strict";
import EventIngestionWorker from "../../src/workers/event-ingestion.worker.js";
import StateEngineWorker from "../../src/workers/state-engine-worker.js";

function fakeBoss() {
  const registrations = [];
  return {
    registrations,
    async work(name, optionsOrHandler, maybeHandler) {
      const handler = typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler;
      registrations.push({ name, options: typeof optionsOrHandler === "object" ? optionsOrHandler : null, handler });
      return "worker-id";
    },
  };
}

test("event ingestion worker accepts the pg-boss single-job callback shape", async () => {
  const boss = fakeBoss();
  const worker = new EventIngestionWorker(boss);
  let received = null;
  worker.ingest = async event => { received = event; };

  await worker.start();
  const registration = boss.registrations.find(item => item.name === "incoming-events");
  assert.ok(registration);
  await registration.handler({ id: "job-1", data: { eventId: "evt-1" } });

  assert.deepEqual(received, { eventId: "evt-1" });
});

test("state engine worker accepts the pg-boss single-job callback shape", async () => {
  const boss = fakeBoss();
  const worker = new StateEngineWorker(boss);
  let received = null;
  worker.handle = async job => { received = job; };

  await worker.start();
  const registration = boss.registrations.find(item => item.name === "state-events");
  assert.ok(registration);
  const job = { id: "job-2", data: { eventId: "evt-2" } };
  await registration.handler(job);

  assert.equal(received, job);
});
