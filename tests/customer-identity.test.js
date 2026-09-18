import test from "node:test";
import assert from "node:assert/strict";

import {
  getCustomerOwnershipIds,
  getOrCreateGuestCustomer,
  resolveAuthenticatedCustomer,
} from "../src/customers/customer.service.js";

function makeCustomerModel(seed = []) {
  const rows = seed.map(item => document(item));
  let creates = 0;

  function document(data) {
    return {
      ...data,
      emailAliases: [...(data.emailAliases || [])],
      async save() {
        return this;
      },
    };
  }

  return {
    rows,
    get creates() { return creates; },
    async findOne(query) {
      if (query.customerId) return rows.find(row => row.customerId === query.customerId) || null;
      if (query.supabaseUserId) return rows.find(row => row.supabaseUserId === query.supabaseUserId) || null;
      if (query.primaryEmail) return rows.find(row => row.primaryEmail === query.primaryEmail) || null;
      return null;
    },
    async create(data) {
      const duplicate = rows.some(row =>
        row.customerId === data.customerId
        || row.primaryEmail === data.primaryEmail
        || (data.supabaseUserId && row.supabaseUserId === data.supabaseUserId)
      );
      if (duplicate) {
        const error = new Error("duplicate");
        error.code = 11000;
        throw error;
      }
      const row = document(data);
      rows.push(row);
      creates += 1;
      return row;
    },
    find(query) {
      const matches = rows.filter(row => row.mergedIntoCustomerId === query.mergedIntoCustomerId);
      return {
        select() {
          return {
            async lean() {
              return matches.map(row => ({ customerId: row.customerId }));
            },
          };
        },
      };
    },
  };
}

function matches(row, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (expected && typeof expected === "object" && "$in" in expected) {
      return expected.$in.includes(row[key]);
    }
    if (expected && typeof expected === "object" && "$exists" in expected) {
      return expected.$exists ? row[key] !== undefined : row[key] === undefined;
    }
    return row[key] === expected;
  });
}

function makeOwnershipModel(seed = []) {
  const rows = seed.map(item => ({ ...item }));
  let updateCalls = 0;
  return {
    rows,
    get updateCalls() { return updateCalls; },
    async updateMany(query, update) {
      updateCalls += 1;
      let modifiedCount = 0;
      for (const row of rows) {
        if (!matches(row, query)) continue;
        Object.assign(row, update.$set || {});
        modifiedCount += 1;
      }
      return { modifiedCount };
    },
  };
}

test("guest checkout customer is reused when the same email authenticates", async () => {
  const customerModel = makeCustomerModel();
  const accountModel = makeOwnershipModel();
  const paymentModel = makeOwnershipModel();

  const guest = await getOrCreateGuestCustomer(" Buyer@Example.com ", { customerModel });
  const originalCustomerId = guest.customerId;

  const authenticated = await resolveAuthenticatedCustomer(
    { id: "supabase-user-1", email: "buyer@example.com" },
    { customerModel, accountModel, paymentModel },
  );

  assert.equal(authenticated.customerId, originalCustomerId);
  assert.equal(authenticated.supabaseUserId, "supabase-user-1");
  assert.equal(authenticated.primaryEmail, "buyer@example.com");

  const callsAfterLink = accountModel.updateCalls + paymentModel.updateCalls;
  await resolveAuthenticatedCustomer(
    { id: "supabase-user-1", email: "buyer@example.com" },
    { customerModel, accountModel, paymentModel },
  );
  assert.equal(accountModel.updateCalls + paymentModel.updateCalls, callsAfterLink);
});

test("legacy records gain customerId without rewriting ownerExternalRef", async () => {
  const customerModel = makeCustomerModel();
  const accountModel = makeOwnershipModel([
    { accountId: "legacy-1", ownerExternalRef: "legacy@example.com" },
  ]);
  const paymentModel = makeOwnershipModel([
    { orderId: "legacy-pay", ownerExternalRef: "supabase-user-2" },
  ]);

  const customer = await resolveAuthenticatedCustomer(
    { id: "supabase-user-2", email: "legacy@example.com" },
    { customerModel, accountModel, paymentModel },
  );

  assert.equal(accountModel.rows[0].customerId, customer.customerId);
  assert.equal(paymentModel.rows[0].customerId, customer.customerId);
  assert.equal(accountModel.rows[0].ownerExternalRef, "legacy@example.com");
  assert.equal(paymentModel.rows[0].ownerExternalRef, "supabase-user-2");
});

test("guest identity merges into existing authenticated customer without changing Trader owner ref", async () => {
  const customerModel = makeCustomerModel([
    {
      customerId: "CUS-AUTH",
      supabaseUserId: "supabase-user-3",
      primaryEmail: "old@example.com",
      emailAliases: [],
      status: "ACTIVE",
    },
    {
      customerId: "CUS-GUEST",
      primaryEmail: "new@example.com",
      emailAliases: [],
      status: "ACTIVE",
    },
  ]);
  const accountModel = makeOwnershipModel([
    { accountId: "paid-1", customerId: "CUS-GUEST", ownerExternalRef: "CUS-GUEST" },
  ]);
  const paymentModel = makeOwnershipModel([
    { orderId: "pay-1", customerId: "CUS-GUEST", ownerExternalRef: "CUS-GUEST" },
  ]);

  const customer = await resolveAuthenticatedCustomer(
    { id: "supabase-user-3", email: "new@example.com" },
    { customerModel, accountModel, paymentModel },
  );

  assert.equal(customer.customerId, "CUS-AUTH");
  assert.equal(accountModel.rows[0].customerId, "CUS-AUTH");
  assert.equal(paymentModel.rows[0].customerId, "CUS-AUTH");
  assert.equal(accountModel.rows[0].ownerExternalRef, "CUS-GUEST");
  assert.equal(paymentModel.rows[0].ownerExternalRef, "CUS-GUEST");

  const guest = customerModel.rows.find(row => row.customerId === "CUS-GUEST");
  assert.equal(guest.status, "MERGED");
  assert.equal(guest.mergedIntoCustomerId, "CUS-AUTH");

  const ownershipIds = await getCustomerOwnershipIds(customer, { customerModel });
  assert.deepEqual(new Set(ownershipIds), new Set(["CUS-AUTH", "CUS-GUEST"]));
});
