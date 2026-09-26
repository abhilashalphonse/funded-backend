import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVE_DEMO_STATUSES,
  FREE_TRIAL_DURATION_DAYS,
  activeDemoAccountQuery,
  customerFacingTrialProvisioningError,
  freeTrialExpiry,
  trialMetadata,
  trialResultForStatus,
} from "../src/apis/services/freeTrialPolicy.js";

test("breached and other terminal trials do not reserve the active free-trial slot", () => {
  const query = activeDemoAccountQuery({ customerId: "CUS-1" });

  assert.equal(query.accountMode, "DEMO");
  assert.equal(query.enabled, true);
  assert.deepEqual(query.status.$in, ["NEW", "ACTIVE", "PHASE_2"]);
  assert.equal(ACTIVE_DEMO_STATUSES.includes("BREACHED"), false);
  assert.equal(ACTIVE_DEMO_STATUSES.includes("LOCKED"), false);
  assert.equal(ACTIVE_DEMO_STATUSES.includes("EXPIRED"), false);
  assert.equal(ACTIVE_DEMO_STATUSES.includes("CLOSED"), false);
});

test("free trials expire exactly fourteen days after creation", () => {
  const startedAt = new Date("2026-09-01T12:00:00.000Z");
  const expiresAt = freeTrialExpiry(startedAt);

  assert.equal(FREE_TRIAL_DURATION_DAYS, 14);
  assert.equal(expiresAt.toISOString(), "2026-09-15T12:00:00.000Z");
});

test("trial metadata preserves expiry and records terminal outcomes", () => {
  const account = {
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    trial: {
      startedAt: new Date("2026-09-01T00:00:00.000Z"),
      expiresAt: new Date("2026-09-15T00:00:00.000Z"),
      result: null,
    },
  };
  const completedAt = new Date("2026-09-10T10:00:00.000Z");
  const result = trialMetadata(account, "PASSED", completedAt);

  assert.equal(result.result, "PASSED");
  assert.equal(result.startedAt.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(result.expiresAt.toISOString(), "2026-09-15T00:00:00.000Z");
  assert.equal(result.completedAt.toISOString(), completedAt.toISOString());
  assert.equal(trialResultForStatus("BREACHED"), "BREACHED");
  assert.equal(trialResultForStatus("EXPIRED"), "EXPIRED");
  assert.equal(trialResultForStatus("CLOSED"), null);
});

test("an actually active trial still blocks creation of a second trial", () => {
  for (const status of ["NEW", "ACTIVE", "PHASE_2"]) {
    assert.equal(ACTIVE_DEMO_STATUSES.includes(status), true);
  }
});

test("ACG Trader provisioning failures are safe and retryable for customers", () => {
  const remote = new Error("ACG Trader request failed (503). Failed checks: marketLive.");
  remote.status = 503;
  remote.code = "TRADING_PROVIDER_REQUEST_FAILED";
  remote.provider = "acg-trader";

  const result = customerFacingTrialProvisioningError(remote);
  assert.equal(result.message, "Trading services are temporarily unavailable. Please try again shortly.");
  assert.equal(result.status, 503);
  assert.equal(result.code, "TRIAL_PROVISIONING_UNAVAILABLE");
  assert.equal(result.retryable, true);
  assert.equal(result.cause, remote);
});

test("customer business conflicts are preserved instead of being masked", () => {
  const conflict = new Error("You already have an active free trial.");
  conflict.status = 409;
  conflict.code = "ACTIVE_TRIAL_EXISTS";

  assert.equal(customerFacingTrialProvisioningError(conflict), conflict);
});
