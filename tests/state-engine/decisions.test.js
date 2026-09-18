import test from "node:test";
import assert from "node:assert/strict";
import { resolveDecision } from "../../src/workers/state-engine/decisions.js";

const passedRules = {
  dailyLossBreached: false,
  maxLossBreached: false,
  profitTargetHit: true,
  minimumDaysMet: true,
};

test("two-step phase one provisions phase two", () => {
  assert.deepEqual(resolveDecision({ status: "ACTIVE", currentPhase: 1, challengeType: "TWO_STEP" }, passedRules), {
    shouldUpdate: true,
    newStatus: "PASSED",
    command: "CREATE_PHASE_2_ACCOUNT",
  });
});

test("one-step completion goes directly to funded review", () => {
  assert.deepEqual(resolveDecision({ status: "ACTIVE", currentPhase: 1, challengeType: "ONE_STEP" }, passedRules), {
    shouldUpdate: true,
    newStatus: "FUNDED_REVIEW",
    command: "ENTER_FUNDED_REVIEW",
  });
});


test("transitional and review states do not emit duplicate commands", () => {
  for (const status of ["PASSED", "FUNDED_REVIEW", "BREACHED"]) {
    assert.deepEqual(resolveDecision({ status, currentPhase: 1, challengeType: "TWO_STEP" }, passedRules), {
      shouldUpdate: false,
      newStatus: status,
      command: null,
    });
  }
});
