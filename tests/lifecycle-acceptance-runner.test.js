import test from "node:test";
import assert from "node:assert/strict";

import {
  AcceptanceReport,
  adjustmentToTarget,
  assertAcceptanceIdentity,
  extractFederationTicket,
  loadAcceptanceConfig,
  phaseTarget,
  validateAcceptanceConfig,
} from "../scripts/lifecycle-acceptance/lib.js";

test("acceptance config requires exact destructive account confirmation", () => {
  const config = loadAcceptanceConfig({
    ACCEPTANCE_FUNDED_BASE_URL: "https://funded.example.com",
    ACCEPTANCE_TRADER_BASE_URL: "https://trader.example.com",
    ACCEPTANCE_CUSTOMER_ID: "customer-1",
    ACCEPTANCE_CUSTOMER_BEARER: "customer-token",
    ACCEPTANCE_ADMIN_BEARER: "admin-token",
    ACCEPTANCE_TRADER_SERVICE_KEY: "service-key",
    ACCEPTANCE_CHALLENGE_A_ID: "A",
    ACCEPTANCE_CHALLENGE_B_ID: "B",
    ACCEPTANCE_CONFIRM_ACCOUNT_IDS: "A,B",
    ACCEPTANCE_ALLOW_DESTRUCTIVE: "YES_I_UNDERSTAND",
  }, []);

  assert.doesNotThrow(() => validateAcceptanceConfig(config));

  const wrong = { ...config, confirmedIds: ["A", "C"] };
  assert.throws(
    () => validateAcceptanceConfig(wrong),
    error => error.code === "ACCEPTANCE_CONFIG_INVALID"
      && error.message.includes("ACCEPTANCE_CONFIRM_ACCOUNT_IDS"),
  );
});

test("dry-run does not require destructive flag", () => {
  const config = loadAcceptanceConfig({
    ACCEPTANCE_FUNDED_BASE_URL: "https://funded.example.com",
    ACCEPTANCE_TRADER_BASE_URL: "https://trader.example.com",
    ACCEPTANCE_CUSTOMER_ID: "customer-1",
    ACCEPTANCE_CUSTOMER_BEARER: "customer-token",
    ACCEPTANCE_ADMIN_BEARER: "admin-token",
    ACCEPTANCE_TRADER_SERVICE_KEY: "service-key",
    ACCEPTANCE_CHALLENGE_A_ID: "A",
    ACCEPTANCE_CHALLENGE_B_ID: "B",
    ACCEPTANCE_CONFIRM_ACCOUNT_IDS: "A,B",
  }, ["--dry-run"]);

  assert.equal(config.dryRun, true);
  assert.doesNotThrow(() => validateAcceptanceConfig(config));
});

test("acceptance identity guard requires dedicated identity by default", () => {
  assert.equal(assertAcceptanceIdentity("qa+acceptance@acgfunded.com"), true);
  assert.throws(
    () => assertAcceptanceIdentity("real-customer@example.com"),
    error => error.code === "ACCEPTANCE_IDENTITY_GUARD",
  );
  assert.equal(assertAcceptanceIdentity("real-customer@example.com", "acceptance", true), true);
});

test("federation launch ticket is extracted from launch URL", () => {
  assert.equal(
    extractFederationTicket("https://trader.example.com/?ticket=abc1234567890123"),
    "abc1234567890123",
  );
  assert.throws(() => extractFederationTicket("https://trader.example.com/"));
});

test("target adjustment uses current balance and configured buffer", () => {
  const account = {
    initialDeposit: 100000,
    accountSize: 100000,
    currentPhase: 1,
    balance: 104000,
    rules: {
      phases: [{ phase: 1, profitTarget: 8 }],
    },
  };
  assert.deepEqual(phaseTarget(account), {
    initial: 100000,
    percent: 8,
    targetBalance: 108000,
  });
  assert.equal(adjustmentToTarget(account, 5), 4005);
});

test("report treats required skips as failure", async () => {
  const report = new AcceptanceReport({ runId: "run-1" });
  await report.run("pass", async () => ({ summary: "ok" }));
  await report.run("skip", async () => ({ status: "SKIP", summary: "optional" }));
  report.finish({ requireAll: true });
  assert.equal(report.status, "FAIL");
  assert.deepEqual(report.summary, { pass: 1, fail: 0, skip: 1, total: 2 });

  const permissive = new AcceptanceReport({ runId: "run-2" });
  await permissive.run("skip", async () => ({ status: "SKIP" }));
  permissive.finish({ requireAll: false });
  assert.equal(permissive.status, "PASS");
});
