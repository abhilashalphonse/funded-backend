import test from "node:test";
import assert from "node:assert/strict";
import {
  createCustomerPayoutRequest,
  getCustomerPayoutQuote,
  quotePayoutSettlement,
} from "../src/apis/services/payout.service.js";
import {
  normalizePayoutDestination,
  SUPPORTED_USDT_NETWORKS,
} from "../src/apis/services/payoutDestination.service.js";

function eligibleMaster(overrides = {}) {
  return {
    accountId: "MASTER-100",
    customerId: "CUS-100",
    ownerExternalRef: "CUS-100",
    accountMode: "CHALLENGE",
    status: "FUNDED",
    enabled: true,
    customerAccessBlocked: false,
    initialDeposit: 100000,
    accountSize: 100000,
    balance: 105000,
    projections: { profit: 5000 },
    commercialTerms: {
      profitSplit: 80,
      payoutFrequency: "On Demand",
    },
    fundedApprovedAt: new Date("2026-09-01T00:00:00.000Z"),
    lastPlatformSnapshotAt: new Date("2026-09-29T12:00:00.000Z"),
    ...overrides,
  };
}

function accountModelWith(account) {
  return {
    async findOne() {
      return account;
    },
  };
}

function memoryPayoutModel(initial = []) {
  const records = [...initial];

  return {
    records,
    find() {
      return {
        sort() { return this; },
        limit() { return this; },
        lean() { return Promise.resolve([...records].reverse()); },
      };
    },
    async findOne(query) {
      return records.find(record =>
        (!query.customerId || record.customerId === query.customerId)
        && (!query.idempotencyKey || record.idempotencyKey === query.idempotencyKey)
      ) || null;
    },
    async create(record) {
      if (records.some(item => item.activeKey && item.activeKey === record.activeKey)) {
        const error = new Error("duplicate active payout");
        error.code = 11000;
        error.keyPattern = { activeKey: 1 };
        throw error;
      }
      if (records.some(item => item.customerId === record.customerId && item.idempotencyKey === record.idempotencyKey)) {
        const error = new Error("duplicate idempotency");
        error.code = 11000;
        error.keyPattern = { customerId: 1, idempotencyKey: 1 };
        throw error;
      }
      const created = { ...record, createdAt: record.requestedAt };
      records.push(created);
      return created;
    },
  };
}

const fixedFx = async amountUsd => ({
  amountInr: Number((Number(amountUsd) * 83).toFixed(2)),
  usdToInr: 83,
  source: "test-fx",
  quoteDate: "2026-09-29",
});

test("UPI quote enforces the ₹100 to ₹20,000 payout range", async () => {
  const small = await quotePayoutSettlement("UPI", 1, {
    fxResolver: async () => ({ amountInr: 83, usdToInr: 83, source: "test", quoteDate: "2026-09-29" }),
  });
  assert.equal(small.available, false);
  assert.equal(small.blocker, "UPI_AMOUNT_OUT_OF_RANGE");

  const valid = await quotePayoutSettlement("UPI", 200, { fxResolver: fixedFx });
  assert.equal(valid.available, true);
  assert.equal(valid.settlementAmount, 16600);

  const large = await quotePayoutSettlement("UPI", 300, { fxResolver: fixedFx });
  assert.equal(large.available, false);
  assert.equal(large.settlementAmount, 24900);
  assert.deepEqual(large.limits, { min: 100, max: 20000, unit: "INR" });
});

test("bank payout quote snapshots the current USD/INR rate without inventing provider limits", async () => {
  const quote = await quotePayoutSettlement("BANK", 4000, { fxResolver: fixedFx });

  assert.equal(quote.available, true);
  assert.equal(quote.settlementCurrency, "INR");
  assert.equal(quote.settlementAmount, 332000);
  assert.equal(quote.fxRate, 83);
  assert.equal(quote.quoteStatus, "LOCKED");
});

test("USDT quote explicitly waits for provider settlement pricing and exposes TRC20", async () => {
  const quote = await quotePayoutSettlement("USDT", 4000);

  assert.equal(quote.available, true);
  assert.equal(quote.settlementCurrency, "USDT");
  assert.equal(quote.settlementAmount, null);
  assert.equal(quote.quoteStatus, "PROVIDER_PENDING");
  assert.deepEqual(quote.networks, SUPPORTED_USDT_NETWORKS);
});

test("payout destinations are validated and customer-facing snapshots are masked", () => {
  const upi = normalizePayoutDestination("UPI", {
    upiId: "trader@upi",
    beneficiaryName: "Trader One",
  });
  assert.equal(upi.payload.upiId, "trader@upi");
  assert.equal(upi.masked.destination, "tr***@upi");

  const bank = normalizePayoutDestination("BANK", {
    beneficiaryName: "Trader One",
    accountNumber: "123456789012",
    ifsc: "HDFC0001234",
    bankName: "HDFC Bank",
  });
  assert.equal(bank.payload.accountNumber, "123456789012");
  assert.equal(bank.masked.destination, "•••• 9012");

  const usdt = normalizePayoutDestination("USDT", {
    network: "TRC20",
    walletAddress: "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE",
  });
  assert.equal(usdt.masked.network, "TRC20");
  assert.equal(usdt.masked.destination, "TQn9Y2…bLSE");
});

test("invalid payout destinations fail before a payout can be reserved", () => {
  assert.throws(
    () => normalizePayoutDestination("UPI", { upiId: "not-an-id", beneficiaryName: "Trader One" }),
    error => error?.code === "INVALID_UPI_ID",
  );

  assert.throws(
    () => normalizePayoutDestination("BANK", {
      beneficiaryName: "Trader One",
      accountNumber: "1234567890",
      ifsc: "BADIFSC",
    }),
    error => error?.code === "INVALID_IFSC",
  );

  assert.throws(
    () => normalizePayoutDestination("USDT", {
      network: "ERC20",
      walletAddress: "0x123",
    }),
    error => error?.code === "UNSUPPORTED_USDT_NETWORK",
  );
});

test("customer can request a full eligible UPI payout and the sensitive destination is not returned", async () => {
  const payoutModel = memoryPayoutModel();
  const account = eligibleMaster({ projections: { profit: 200 } }); // 80% = $160 -> ₹13,280

  const result = await createCustomerPayoutRequest(
    { id: "auth-100", customerId: "CUS-100", email: "trader@example.com" },
    account.accountId,
    {
      method: "UPI",
      amountUsd: 160,
      idempotencyKey: "payout-request-0001",
      destination: {
        upiId: "trader@upi",
        beneficiaryName: "Trader One",
      },
    },
    {
      accountModel: accountModelWith(account),
      payoutModel,
      now: () => new Date("2026-09-29T12:00:00.000Z"),
      fxResolver: fixedFx,
      destinationEncryptor: payload => ({
        destinationEncrypted: Buffer.from(JSON.stringify(payload)).toString("base64"),
        destinationIv: "test-iv",
        destinationAuthTag: "test-tag",
        destinationKeyVersion: "test",
      }),
      payoutIdFactory: () => "PAYOUT-TEST-0001",
    },
  );

  assert.equal(result.idempotent, false);
  assert.equal(result.payout.payoutId, "PAYOUT-TEST-0001");
  assert.equal(result.payout.status, "REQUESTED");
  assert.equal(result.payout.requestedAmountUsd, 160);
  assert.equal(result.payout.settlementAmount, 13280);
  assert.equal(result.payout.destination.destination, "tr***@upi");
  assert.equal(result.payout.destinationEncrypted, undefined);

  assert.equal(payoutModel.records.length, 1);
  assert.equal(payoutModel.records[0].activeKey, account.accountId);
  assert.ok(payoutModel.records[0].destinationEncrypted);
  assert.equal(payoutModel.records[0].snapshot.availableBeforeRequestUsd, 160);
});

test("replaying the same idempotency key returns the original payout instead of creating a duplicate", async () => {
  const payoutModel = memoryPayoutModel();
  const account = eligibleMaster({ projections: { profit: 200 } });
  const deps = {
    accountModel: accountModelWith(account),
    payoutModel,
    now: () => new Date("2026-09-29T12:00:00.000Z"),
    fxResolver: fixedFx,
    destinationEncryptor: () => ({
      destinationEncrypted: "cipher",
      destinationIv: "iv",
      destinationAuthTag: "tag",
      destinationKeyVersion: "test",
    }),
    payoutIdFactory: () => "PAYOUT-TEST-0002",
  };
  const input = {
    method: "UPI",
    amountUsd: 160,
    idempotencyKey: "payout-request-0002",
    destination: { upiId: "trader@upi", beneficiaryName: "Trader One" },
  };

  const first = await createCustomerPayoutRequest(
    { id: "auth-100", customerId: "CUS-100", email: "trader@example.com" },
    account.accountId,
    input,
    deps,
  );
  const second = await createCustomerPayoutRequest(
    { id: "auth-100", customerId: "CUS-100", email: "trader@example.com" },
    account.accountId,
    input,
    deps,
  );

  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(second.payout.payoutId, first.payout.payoutId);
  assert.equal(payoutModel.records.length, 1);
});

test("customer payout quote refuses amounts above the payout ledger balance", async () => {
  const account = eligibleMaster({ projections: { profit: 1000 } }); // $800 share

  await assert.rejects(
    () => getCustomerPayoutQuote(
      { customerId: "CUS-100" },
      account.accountId,
      { method: "BANK", amountUsd: 900 },
      {
        accountModel: accountModelWith(account),
        payoutModel: memoryPayoutModel(),
        fxResolver: fixedFx,
      },
    ),
    error => error?.code === "PAYOUT_AMOUNT_EXCEEDS_AVAILABLE" && error?.availableUsd === 800,
  );
});

test("an active payout blocks a second payout even with a different idempotency key", async () => {
  const account = eligibleMaster({ projections: { profit: 1000 } });
  const payoutModel = memoryPayoutModel([{
    payoutId: "PAYOUT-ACTIVE",
    customerId: "CUS-100",
    accountId: account.accountId,
    activeKey: account.accountId,
    idempotencyKey: "existing-request",
    status: "REVIEWING",
    requestedAmountUsd: 300,
    cycle: { key: "ON_DEMAND" },
  }]);

  await assert.rejects(
    () => createCustomerPayoutRequest(
      { customerId: "CUS-100" },
      account.accountId,
      {
        method: "BANK",
        amountUsd: 100,
        idempotencyKey: "new-request-key",
        destination: {
          beneficiaryName: "Trader One",
          accountNumber: "123456789012",
          ifsc: "HDFC0001234",
        },
      },
      {
        accountModel: accountModelWith(account),
        payoutModel,
        fxResolver: fixedFx,
        destinationEncryptor: () => ({
          destinationEncrypted: "cipher",
          destinationIv: "iv",
          destinationAuthTag: "tag",
        }),
      },
    ),
    error => error?.code === "PAYOUT_NOT_ELIGIBLE"
      && Array.isArray(error?.blockers)
      && error.blockers.includes("PAYOUT_ALREADY_IN_PROGRESS"),
  );
});
