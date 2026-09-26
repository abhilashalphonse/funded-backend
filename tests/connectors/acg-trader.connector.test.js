import test from "node:test";
import assert from "node:assert/strict";
import { ACGTraderConnector } from "../../src/connectors/acg-trader/connector.js";

class FakeClient {
  constructor() { this.calls = []; }
  async provisionAccount(command) {
    this.calls.push(["provision", command]);
    return { account: { id: "66aa00112233445566778899", accountCode: "ACG-TEST", state: { balance: "100000" } }, idempotentReplay: false };
  }
  async createFederationTicket(command) {
    this.calls.push(["ticket", command]);
    return { ticket: "one-time-ticket", expiresAt: "2026-09-17T10:00:00.000Z" };
  }
  async pauseAccount(accountId, options) { this.calls.push(["pause", accountId, options]); return { changed: true }; }
  async resumeAccount(accountId, options) { this.calls.push(["resume", accountId, options]); return { changed: true }; }
  async breachAccount(accountId, options) { this.calls.push(["breach", accountId, options]); return { changed: true }; }
  async flattenAccount(accountId, options) { this.calls.push(["flatten", accountId, options]); return { changed: true }; }
  async syncChallenge(accountId, patch) { this.calls.push(["syncChallenge", accountId, patch]); return { operation: "CHALLENGE_SYNC" }; }
}

test("ACG Trader connector maps generic provisioning to Trader contract", async () => {
  const client = new FakeClient();
  const connector = new ACGTraderConnector({ client, frontendUrl: "https://trade.example.test/" });
  const result = await connector.provisionAccount({
    externalRef: "challenge-1:phase:1",
    ownerExternalRef: "user-1",
    accountType: "CHALLENGE",
    initialBalance: 100000,
    leverage: 100,
    riskPolicy: { profitTarget: "10000" },
    metadata: { phase: 1, ignored: { nested: true } },
  });

  assert.equal(result.provider, "acg-trader");
  assert.equal(result.platformAccountId, "66aa00112233445566778899");
  assert.equal(result.accountCode, "ACG-TEST");
  assert.equal(client.calls[0][1].externalRef, "challenge-1:phase:1");
  assert.equal(client.calls[0][1].metadata.phase, 1);
  assert.equal("ignored" in client.calls[0][1].metadata, false);
});

test("ACG Trader connector returns provider-neutral federated session", async () => {
  const client = new FakeClient();
  const connector = new ACGTraderConnector({ client, frontendUrl: "https://trade.example.test/" });
  const session = await connector.createTradingSession({
    ownerExternalRef: "user-1",
    ownerExternalRefs: ["user-1", "legacy-user-1"],
    platformAccountIds: ["66aa00112233445566778899", "66aa00112233445566778898"],
    selectedAccountId: "66aa00112233445566778898",
    metadata: { source: "dashboard" },
  });

  assert.deepEqual(session, {
    provider: "acg-trader",
    type: "FEDERATED",
    ticket: "one-time-ticket",
    expiresAt: "2026-09-17T10:00:00.000Z",
    selectedAccountId: "66aa00112233445566778898",
    launchUrl: "https://trade.example.test",
  });
  assert.deepEqual(client.calls[0][1].accountIds, ["66aa00112233445566778899", "66aa00112233445566778898"]);
  assert.deepEqual(client.calls[0][1].ownerExternalRefs, ["user-1", "legacy-user-1"]);
  assert.equal(client.calls[0][1].selectedAccountId, "66aa00112233445566778898");
});

test("ACG Trader connector routes pause and resume to the same provider account", async () => {
  const client = new FakeClient();
  const connector = new ACGTraderConnector({ client });
  await connector.pauseAccount({ platformAccountId: "66aa00112233445566778899", reason: "REVIEW", cancelPending: true });
  await connector.resumeAccount({ platformAccountId: "66aa00112233445566778899", reason: "REVIEW_CLEARED" });
  assert.deepEqual(client.calls[0], ["pause", "66aa00112233445566778899", { reason: "REVIEW", cancelPending: true }]);
  assert.deepEqual(client.calls[1], ["resume", "66aa00112233445566778899", { reason: "REVIEW_CLEARED" }]);
});

test("ACG Trader connector routes breaches to the provider account", async () => {
  const client = new FakeClient();
  const connector = new ACGTraderConnector({ client });
  await connector.breachAccount({ platformAccountId: "66aa00112233445566778899", reason: "RULE", action: "LIQUIDATE_AND_LOCK" });
  assert.deepEqual(client.calls[0], ["breach", "66aa00112233445566778899", { reason: "RULE", action: "LIQUIDATE_AND_LOCK" }]);
});


test("ACG Trader connector routes reversible phase flatten to the provider account", async () => {
  const client = new FakeClient();
  const connector = new ACGTraderConnector({ client });
  await connector.flattenAccount({ platformAccountId: "66aa00112233445566778899", reason: "PHASE_CHECK" });
  assert.deepEqual(client.calls[0], ["flatten", "66aa00112233445566778899", { reason: "PHASE_CHECK" }]);
});


test("ACG Trader connector syncs the authoritative Funded risk policy version", async () => {
  const client = new FakeClient();
  const connector = new ACGTraderConnector({ client });
  await connector.syncChallenge({
    platformAccountId: "66aa00112233445566778899",
    riskPolicy: { maxRiskPerTradePercent: 1, maxAggregateRiskPercent: 2 },
    riskPolicyVersion: "ACG_FUNDED_V1",
  });

  assert.deepEqual(client.calls[0], [
    "syncChallenge",
    "66aa00112233445566778899",
    {
      riskPolicy: { maxRiskPerTradePercent: 1, maxAggregateRiskPercent: 2 },
      riskPolicyVersion: "ACG_FUNDED_V1",
    },
  ]);
});
