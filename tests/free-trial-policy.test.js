import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVE_DEMO_STATUSES,
  activeDemoAccountQuery,
  customerFacingTrialProvisioningError,
} from "../src/apis/services/freeTrialPolicy.js";

test("breached and other terminal trials do not reserve the active free-trial slot", () => {
  const query = activeDemoAccountQuery({ customerId: "CUS-1" });

  assert.equal(query.accountMode, "DEMO");
  assert.equal(query.enabled, true);
  assert.deepEqual(query.status.$in, ["NEW", "ACTIVE", "PHASE_2"]);
  assert.equal(ACTIVE_DEMO_STATUSES.includes("BREACHED"), false);
  assert.equal(ACTIVE_DEMO_STATUSES.includes("LOCKED"), false);
  assert.equal(ACTIVE_DEMO_STATUSES.includes("CLOSED"), false);
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
