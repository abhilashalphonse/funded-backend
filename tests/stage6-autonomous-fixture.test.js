import test from "node:test";
import assert from "node:assert/strict";
import { assertStage6FixtureEnvironment } from "../scripts/stage6-autonomous-fixture.js";

const VALID = {
  RAILWAY_PROJECT_ID: "b1855fe2-326b-47e4-889a-1c5a620d6ac5",
  RAILWAY_ENVIRONMENT_ID: "9bf760f4-11d3-4c47-8181-0ec369251283",
  RAILWAY_SERVICE_ID: "59694cbf-60fb-4cb1-ba60-eaccce86cdb9",
  RAILWAY_ENVIRONMENT_NAME: "STAGING",
  STAGE6_FIXTURE_ONE_SHOT_CONFIRM: "RELIANCE-STAGING-FIXTURE-ONLY",
  STAGE6_FIXTURE_ONCE_ID: "stage6-oct9-autonomous-v1",
  ACG_TRADER_BASE_URL: "https://discerning-presence-staging.up.railway.app",
  ACG_FUNDED_RISK_POLICY_VERSION: "ACG_FUNDED_V2",
  TRADING_PROVIDER: "acg-trader",
};

test("one-shot Stage 6 fixture preflight is restricted to the exact Railway Funded STAGING context", () => {
  assert.equal(assertStage6FixtureEnvironment(VALID), true);
  const invalid = [
    { RAILWAY_PROJECT_ID: "2c77c657-8a52-4741-8e4e-44c936de5f92" },
    { RAILWAY_ENVIRONMENT_ID: "production" },
    { RAILWAY_SERVICE_ID: "a-different-service" },
    { RAILWAY_ENVIRONMENT_NAME: "PRODUCTION" },
    { RAILWAY_ENVIRONMENT_NAME: "" },
    { STAGE6_FIXTURE_ONE_SHOT_CONFIRM: "" },
    { STAGE6_FIXTURE_ONCE_ID: "" },
    { STAGE6_FIXTURE_ONCE_ID: "replay" },
    { ACG_TRADER_BASE_URL: "https://acg-trader-backend-production.up.railway.app" },
    { ACG_TRADER_BASE_URL: "https://attacker-staging.example.net" },
    { ACG_FUNDED_RISK_POLICY_VERSION: "ACG_FUNDED_V1" },
    { TRADING_PROVIDER: "simulator" },
  ];
  for (const replacement of invalid) {
    assert.throws(() => assertStage6FixtureEnvironment({ ...VALID, ...replacement }), /STAGE6_GUARD/);
  }
});
