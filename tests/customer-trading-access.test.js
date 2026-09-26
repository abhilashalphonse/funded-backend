import test from "node:test";
import assert from "node:assert/strict";

import {
  assertCustomerTradingAccessAllowed,
  blockCustomerTradingAccounts,
  reactivateCustomerTradingAccounts,
} from "../src/apis/services/customerTradingAccess.service.js";

function customerStatusQuery(status) {
  return {
    select() { return this; },
    async lean() { return status == null ? null : { status }; },
  };
}

test("activation guard rejects an account-level customer block without touching Customer lookup", async () => {
  let lookups = 0;
  const customerModel = {
    findOne() {
      lookups += 1;
      return customerStatusQuery("ACTIVE");
    },
  };

  await assert.rejects(
    () => assertCustomerTradingAccessAllowed(
      { customerId: "CUS-1", customerAccessBlocked: true },
      { customerModel, code: "BLOCKED_TEST" },
    ),
    error => error?.code === "BLOCKED_TEST",
  );
  assert.equal(lookups, 0);
});

test("activation guard rechecks Customer.status to catch a concurrent block", async () => {
  const customerModel = {
    findOne() {
      return customerStatusQuery("BLOCKED");
    },
  };

  await assert.rejects(
    () => assertCustomerTradingAccessAllowed(
      { customerId: "CUS-1", customerAccessBlocked: false },
      { customerModel, code: "BLOCKED_DURING_ACTIVATION" },
    ),
    error => error?.code === "BLOCKED_DURING_ACTIVATION",
  );
});

test("customer block writes durable local denial before pausing Trader, including disabled in-flight accounts", async () => {
  const sequence = [];
  let updateFilter;
  let updateDocument;
  const account = {
    accountId: "ACG-1",
    customerId: "CUS-1",
    status: "ACTIVE",
    enabled: false,
    customerAccessBlocked: true,
    platform: "acg-trader",
    platformAccountId: "TRADER-1",
    platformAccounts: [{ platformAccountId: "TRADER-1", status: "ACTIVE" }],
    async save() { sequence.push("save"); },
  };
  const accountModel = {
    async updateMany(filter, update) {
      sequence.push("durable-block");
      updateFilter = filter;
      updateDocument = update;
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async find() {
      sequence.push("load-after-block");
      return [account];
    },
  };
  const connectorResolver = () => ({
    async pauseAccount() {
      sequence.push("remote-pause");
    },
  });

  const result = await blockCustomerTradingAccounts(["CUS-1"], { accountModel, connectorResolver });

  assert.deepEqual(updateDocument, {
    $set: { customerAccessBlocked: true, enabled: false },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(updateFilter, "enabled"), false);
  assert.deepEqual(updateFilter.status.$nin, ["BREACHED", "EXPIRED", "CLOSED"]);
  assert.ok(sequence.indexOf("durable-block") < sequence.indexOf("remote-pause"));
  assert.equal(account.platformAccounts[0].status, "PAUSED");
  assert.equal(result.platformErrors.length, 0);
});

test("reactivation does not blindly resume a transitional account", async () => {
  let resumeCalls = 0;
  const account = {
    accountId: "TRIAL-1",
    customerId: "CUS-1",
    status: "PASSED",
    enabled: false,
    customerAccessBlocked: true,
    platform: "acg-trader",
    platformAccountId: "TRADER-1",
    platformAccounts: [{ platformAccountId: "TRADER-1", status: "PAUSED" }],
    async save() {},
  };
  const accountModel = {
    async find() { return [account]; },
  };
  const connectorResolver = () => ({
    async resumeAccount() { resumeCalls += 1; },
  });

  const result = await reactivateCustomerTradingAccounts(["CUS-1"], { accountModel, connectorResolver });

  assert.equal(resumeCalls, 0);
  assert.equal(account.customerAccessBlocked, false);
  assert.equal(account.enabled, false);
  assert.equal(account.platformAccounts[0].status, "PAUSED");
  assert.equal(result.platformErrors.length, 0);
});

test("reactivation resumes an actually tradable paused account", async () => {
  let resumeCalls = 0;
  const account = {
    accountId: "ACG-2",
    customerId: "CUS-1",
    status: "PHASE_2",
    enabled: false,
    customerAccessBlocked: true,
    platform: "acg-trader",
    platformAccountId: "TRADER-2",
    platformAccounts: [{ platformAccountId: "TRADER-2", status: "PAUSED" }],
    async save() {},
  };
  const accountModel = {
    async find() { return [account]; },
  };
  const connectorResolver = () => ({
    async resumeAccount() { resumeCalls += 1; },
  });

  const result = await reactivateCustomerTradingAccounts(["CUS-1"], { accountModel, connectorResolver });

  assert.equal(resumeCalls, 1);
  assert.equal(account.customerAccessBlocked, false);
  assert.equal(account.enabled, true);
  assert.equal(account.platformAccounts[0].status, "ACTIVE");
  assert.equal(result.platformErrors.length, 0);
});
