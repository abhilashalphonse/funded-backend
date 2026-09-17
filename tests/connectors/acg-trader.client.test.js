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
