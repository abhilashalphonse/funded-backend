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
  async breachAccount(accountId, options) { this.calls.push(["breach", accountId, options]); return { changed: true }; }
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
    platformAccountIds: ["66aa00112233445566778899"],
    metadata: { source: "dashboard" },
  });

  assert.deepEqual(session, {
    provider: "acg-trader",
    type: "FEDERATED",
    ticket: "one-time-ticket",
    expiresAt: "2026-09-17T10:00:00.000Z",
    launchUrl: "https://trade.example.test",
  });
});

test("ACG Trader connector routes breaches to the provider account", async () => {
  const client = new FakeClient();
  const connector = new ACGTraderConnector({ client });
  await connector.breachAccount({ platformAccountId: "66aa00112233445566778899", reason: "RULE", action: "LIQUIDATE_AND_LOCK" });
  assert.deepEqual(client.calls[0], ["breach", "66aa00112233445566778899", { reason: "RULE", action: "LIQUIDATE_AND_LOCK" }]);
});
