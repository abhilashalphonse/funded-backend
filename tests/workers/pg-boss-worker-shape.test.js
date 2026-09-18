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

test("event ingestion worker accepts single-job and array callback shapes", async () => {
  const boss = fakeBoss();
  const worker = new EventIngestionWorker(boss);
  const received = [];
  worker.ingest = async event => { received.push(event); };

  await worker.start();
  const registration = boss.registrations.find(item => item.name === "incoming-events");
  assert.ok(registration);

  await registration.handler({ id: "job-1", data: { eventId: "evt-1" } });
  await registration.handler([
    { id: "job-2", data: { eventId: "evt-2" } },
    { id: "job-3", data: { eventId: "evt-3" } },
  ]);

  assert.deepEqual(received, [
    { eventId: "evt-1" },
    { eventId: "evt-2" },
    { eventId: "evt-3" },
  ]);
});

test("state engine worker accepts single-job and array callback shapes", async () => {
  const boss = fakeBoss();
  const worker = new StateEngineWorker(boss);
  const received = [];
  worker.handle = async job => { received.push(job); };

  await worker.start();
  const registration = boss.registrations.find(item => item.name === "state-events");
  assert.ok(registration);

  const first = { id: "job-4", data: { eventId: "evt-4" } };
  const second = { id: "job-5", data: { eventId: "evt-5" } };
  const third = { id: "job-6", data: { eventId: "evt-6" } };
  await registration.handler(first);
  await registration.handler([second, third]);

  assert.deepEqual(received, [first, second, third]);
});
