import test from "node:test";
import assert from "node:assert/strict";

import { trialLifecycleIsLive } from "../src/workers/command-worker.js";

test("Trial lifecycle transition is live only before the persisted 14-day expiry", () => {
  const account = {
    accountMode: "DEMO",
    trial: { expiresAt: new Date("2026-09-15T12:00:00.000Z") },
  };

  assert.equal(trialLifecycleIsLive(account, new Date("2026-09-15T11:59:59.999Z")), true);
  assert.equal(trialLifecycleIsLive(account, new Date("2026-09-15T12:00:00.000Z")), false);
});

test("legacy Trial transition falls back to createdAt plus fourteen days", () => {
  const account = {
    accountMode: "DEMO",
    createdAt: new Date("2026-09-01T12:00:00.000Z"),
    trial: {},
  };

  assert.equal(trialLifecycleIsLive(account, new Date("2026-09-15T11:59:59.999Z")), true);
  assert.equal(trialLifecycleIsLive(account, new Date("2026-09-15T12:00:00.000Z")), false);
});

test("paid challenge lifecycle is not constrained by Trial expiry", () => {
  assert.equal(trialLifecycleIsLive({ accountMode: "CHALLENGE" }, new Date("2030-01-01T00:00:00.000Z")), true);
});
