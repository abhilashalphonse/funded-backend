import test from "node:test";
import assert from "node:assert/strict";
import { ACGTraderClient } from "../../src/connectors/acg-trader/client.js";

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test("ACG Trader client sends service auth headers without leaking credentials into URL", async () => {
  const calls = [];
  const client = new ACGTraderClient({
    baseUrl: "http://localhost:4000/",
    clientId: "funded-backend",
    apiKey: "secret-key",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(201, { account: { id: "66aa00112233445566778899" } });
    },
  });

  await client.provisionAccount({ externalRef: "x" });
  assert.equal(calls[0].url, "http://localhost:4000/v1/internal/trading/accounts/provision");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-key");
  assert.equal(calls[0].options.headers["X-ACG-Client-Id"], "funded-backend");
  assert.equal(calls[0].url.includes("secret-key"), false);
});

test("ACG Trader client preserves remote error code and request id", async () => {
  const client = new ACGTraderClient({
    baseUrl: "http://localhost:4000",
    clientId: "funded-backend",
    apiKey: "secret-key",
    fetchImpl: async () => response(409, { error: { code: "ACCOUNT_PROVISIONING_CONFLICT", message: "conflict", requestId: "req-1" } }),
  });

  await assert.rejects(
    () => client.provisionAccount({}),
    error => error.code === "ACCOUNT_PROVISIONING_CONFLICT" && error.requestId === "req-1" && error.status === 409,
  );
});


test("ACG Trader federation launch retries one transient 502", async () => {
  let calls = 0;
  const client = new ACGTraderClient({
    baseUrl: "http://localhost:4000",
    clientId: "funded-backend",
    apiKey: "secret-key",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return response(502, {});
      return response(201, { ticket: "ticket-1", expiresAt: "2026-09-19T03:00:00.000Z" });
    },
  });

  const result = await client.createFederationTicket({
    ownerExternalRef: "user-1",
    accountIds: ["66aa00112233445566778899"],
  });

  assert.equal(calls, 2);
  assert.equal(result.ticket, "ticket-1");
});

test("ACG Trader federation launch does not retry application 4xx", async () => {
  let calls = 0;
  const client = new ACGTraderClient({
    baseUrl: "http://localhost:4000",
    clientId: "funded-backend",
    apiKey: "secret-key",
    fetchImpl: async () => {
      calls += 1;
      return response(403, { error: { code: "ACCOUNT_GRANT_FORBIDDEN", message: "forbidden" } });
    },
  });

  await assert.rejects(
    () => client.createFederationTicket({
      ownerExternalRef: "user-1",
      accountIds: ["66aa00112233445566778899"],
    }),
    error => error.code === "ACCOUNT_GRANT_FORBIDDEN",
  );
  assert.equal(calls, 1);
});


test("ACG Trader client calls the flatten lifecycle endpoint", async () => {
  const calls = [];
  const client = new ACGTraderClient({
    baseUrl: "http://localhost:4000",
    clientId: "funded-backend",
    apiKey: "secret-key",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { account: { id: "66aa00112233445566778899", status: "PAUSED" } });
    },
  });

  await client.flattenAccount("66aa00112233445566778899", { reason: "PHASE_CHECK" });
  assert.equal(calls[0].url, "http://localhost:4000/v1/internal/trading/accounts/66aa00112233445566778899/flatten");
  assert.equal(JSON.parse(calls[0].options.body).reason, "PHASE_CHECK");
});
