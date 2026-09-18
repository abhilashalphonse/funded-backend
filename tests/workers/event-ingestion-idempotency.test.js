import test from "node:test";
import assert from "node:assert/strict";
import { stateJobId } from "../../src/workers/event-ingestion.worker.js";

test("stateJobId is deterministic per Funded event", () => {
  const eventId = "acg-trader:123e4567-e89b-12d3-a456-426614174000";
  assert.equal(stateJobId(eventId), stateJobId(eventId));
});

test("different Funded events receive different state job ids", () => {
  const first = stateJobId("acg-trader:event-a");
  const second = stateJobId("acg-trader:event-b");

  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.match(second, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});
