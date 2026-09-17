import test from "node:test";
import assert from "node:assert/strict";
import { signACGTraderWebhook, verifyACGTraderWebhook } from "../../src/connectors/acg-trader/webhook-signature.js";
import { validateEnvelope, platformAccountMatches } from "../../src/apis/controllers/acgTraderWebhook.controller.js";

const SECRET = "test-secret-at-least-16-chars";

function envelope() {
  return {
    eventId: "acg-trader:event-123",
    eventType: "ACG_TRADER_ACCOUNT_SNAPSHOT",
    aggregateId: "FUNDED-100",
    timestamp: "2026-09-17T15:00:00.000Z",
    payload: {
      provider: "acg-trader",
      platformAccountId: "64b000000000000000000001",
      balance: "100000",
      equity: "99500",
      margin: "1000",
      marginFree: "98500",
    },
    metadata: { phase: "1" },
  };
}

test("ACG Trader webhook signature verifies canonical payloads", () => {
  const body = envelope();
  const timestamp = "1790000000000";
  const signature = signACGTraderWebhook(SECRET, timestamp, body);
  assert.equal(verifyACGTraderWebhook({ secret: SECRET, timestamp, signature, body, nowMs: Number(timestamp) }), true);
});

test("ACG Trader webhook signature rejects tampered payloads", () => {
  const body = envelope();
  const timestamp = "1790000000000";
  const signature = signACGTraderWebhook(SECRET, timestamp, body);
  body.payload.equity = "1";
  assert.throws(() => verifyACGTraderWebhook({ secret: SECRET, timestamp, signature, body, nowMs: Number(timestamp) }), error => error.code === "ACG_TRADER_WEBHOOK_SIGNATURE_INVALID");
});

test("ACG Trader webhook rejects expired timestamps", () => {
  const body = envelope();
  const timestamp = "1790000000000";
  const signature = signACGTraderWebhook(SECRET, timestamp, body);
  assert.throws(() => verifyACGTraderWebhook({ secret: SECRET, timestamp, signature, body, nowMs: Number(timestamp) + 300001 }), error => error.code === "ACG_TRADER_WEBHOOK_EXPIRED");
});

test("canonical ACG Trader event envelope validates", () => {
  assert.doesNotThrow(() => validateEnvelope(envelope()));
});

test("platform account binding accepts current and phase account IDs only", () => {
  const account = {
    platformAccountId: "current",
    platformAccounts: [{ platformAccountId: "phase-1" }, { platformAccountId: "phase-2" }],
  };
  assert.equal(platformAccountMatches(account, "current"), true);
  assert.equal(platformAccountMatches(account, "phase-1"), true);
  assert.equal(platformAccountMatches(account, "other"), false);
});
