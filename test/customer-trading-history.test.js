import test from "node:test";
import assert from "node:assert/strict";
import { getCustomerTradingHistory } from "../src/apis/services/customer.service.js";

const customer = {
  id: "auth-user-1",
  customerId: "customer-1",
  customerIds: ["customer-1"],
  email: "trader@example.com",
};

test("customer trade history reads only the owned platform account and normalizes the query", async () => {
  let capturedAccountQuery = null;
  let capturedConnectorQuery = null;

  const accountModel = {
    async findOne(query) {
      capturedAccountQuery = query;
      return {
        accountId: "CHALLENGE-001",
        platform: "acg-trader",
        platformAccountId: "64b64b64b64b64b64b64b64b",
      };
    },
  };

  const connectorResolver = provider => {
    assert.equal(provider, "acg-trader");
    return {
      async adminTrades(query) {
        capturedConnectorQuery = query;
        return {
          items: [{ dealId: "deal-1", type: "CLOSE", realizedPnl: "125.50" }],
          page: { limit: 200, hasMore: false, nextCursor: null },
        };
      },
    };
  };

  const result = await getCustomerTradingHistory(
    customer,
    "CHALLENGE-001",
    {
      limit: "999",
      symbol: "eurusd",
      side: "buy",
      type: "close",
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-30T23:59:59.999Z",
    },
    { accountModel, connectorResolver },
  );

  assert.equal(capturedAccountQuery.accountId, "CHALLENGE-001");
  assert.ok(Array.isArray(capturedAccountQuery.$or));
  assert.deepEqual(capturedConnectorQuery, {
    accountId: "64b64b64b64b64b64b64b64b",
    limit: 200,
    symbol: "EURUSD",
    side: "BUY",
    type: "CLOSE",
    from: "2026-09-01T00:00:00.000Z",
    to: "2026-09-30T23:59:59.999Z",
  });
  assert.equal(result.accountId, "CHALLENGE-001");
  assert.equal(result.timezone, "UTC");
  assert.equal(result.items.length, 1);
  assert.equal(result.page.hasMore, false);
});

test("customer trade history does not call the connector when the account is not owned", async () => {
  let connectorCalled = false;
  const accountModel = { async findOne() { return null; } };
  const connectorResolver = () => {
    connectorCalled = true;
    return { adminTrades: async () => ({ items: [] }) };
  };

  await assert.rejects(
    () => getCustomerTradingHistory(customer, "OTHER-ACCOUNT", {}, { accountModel, connectorResolver }),
    error => error?.status === 404 && error?.code === "TRADING_ACCOUNT_NOT_FOUND",
  );
  assert.equal(connectorCalled, false);
});

test("customer trade history rejects malformed cursors before provider access", async () => {
  let connectorCalled = false;
  const accountModel = {
    async findOne() {
      return {
        accountId: "CHALLENGE-001",
        platform: "acg-trader",
        platformAccountId: "64b64b64b64b64b64b64b64b",
      };
    },
  };
  const connectorResolver = () => ({
    async adminTrades() {
      connectorCalled = true;
      return { items: [] };
    },
  });

  await assert.rejects(
    () => getCustomerTradingHistory(
      customer,
      "CHALLENGE-001",
      { cursor: "not-a-cursor" },
      { accountModel, connectorResolver },
    ),
    error => error?.status === 400 && error?.code === "INVALID_TRADING_HISTORY_QUERY",
  );
  assert.equal(connectorCalled, false);
});
