import test from "node:test";
import assert from "node:assert/strict";

import {
  acceptanceChallengeSpec,
  validateAcceptanceConfirmation,
} from "../src/maintenance/adminLaunchReadiness.js";

test("acceptance confirmation requires exact destructive phrase and reason", () => {
  assert.throws(
    () => validateAcceptanceConfirmation({ confirmation: "RUN", reason: "launch test" }),
    error => error?.code === "ACCEPTANCE_CONFIRMATION_REQUIRED",
  );
  assert.throws(
    () => validateAcceptanceConfirmation({ confirmation: "RUN ACCEPTANCE", reason: "x" }),
    error => error?.code === "ACCEPTANCE_REASON_REQUIRED",
  );
  assert.equal(
    validateAcceptanceConfirmation({ confirmation: "RUN ACCEPTANCE", reason: "launch validation" }),
    true,
  );
});

test("acceptance challenge fixture is deterministic two-step with zero minimum days", () => {
  const spec = acceptanceChallengeSpec({
    accountId: "ACG-ACC-TEST-A",
    customerId: "CUS-ACC-TEST",
    accountSize: 10000,
  });

  assert.equal(spec.accountMode, "CHALLENGE");
  assert.equal(spec.challengeType, "TWO_STEP");
  assert.equal(spec.currentPhase, 1);
  assert.equal(spec.status, "NEW");
  assert.equal(spec.enabled, false);
  assert.equal(spec.rules.minimumTradingDays, 0);
  assert.equal(spec.rules.dailyDrawdown, 5);
  assert.equal(spec.rules.maxDrawdown, 10);
  assert.deepEqual(spec.rules.phases, [
    { phase: 1, profitTarget: 1 },
    { phase: 2, profitTarget: 1 },
  ]);
  assert.equal(spec.leverage, 100);
});
