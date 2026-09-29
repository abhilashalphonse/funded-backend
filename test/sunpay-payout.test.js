import test from "node:test";
import assert from "node:assert/strict";
import {
  computeSunpayPayoutSignature,
  createSunpayPayout,
  getSunpayPayoutBalance,
  getSunpayPayoutStatus,
  normalizeSunpayPayoutStatus,
  verifySunpayPayoutWebhook,
} from "../src/apis/services/payoutProviders/sunpayPayout.service.js";
import {
  executeApprovedSunpayPayout,
  reconcileSunpayPayout,
} from "../src/apis/services/payoutProviders/payoutExecution.service.js";

const API_KEY = "payout-key";
const API_SECRET = "payout-secret";
const BASE_URL = "https://ttpay.business";
const CALLBACK_URL = "https://example.com/api/webhooks/payouts/sunpay";

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
  };
}

test("Sunpay payout signing uses the exact raw JSON body", () => {
  const raw = Buffer.from('{"payout_id":"PO_001","amount":1000}', "utf8");
  const signature = computeSunpayPayoutSignature(raw, API_SECRET);

  assert.match(signature, /^[0-9a-f]{64}$/);
  assert.equal(verifySunpayPayoutWebhook(raw, signature, API_SECRET), true);
  const wrong = signature.slice(0, -1) + (signature.endsWith("0") ? "1" : "0");
  assert.equal(verifySunpayPayoutWebhook(raw, wrong, API_SECRET), false);
});

test("Sunpay creates UPI payout with payout credentials and signed body", async () => {
  let request = null;
  const result = await createSunpayPayout({
    payoutId: "PAYOUT-001",
    amountInr: 1000,
    method: "UPI",
    beneficiaryName: "Trader One",
    beneficiaryAccount: "trader@upi",
  }, {
    baseUrlValue: BASE_URL,
    apiKeyValue: API_KEY,
    apiSecretValue: API_SECRET,
    callbackUrlValue: CALLBACK_URL,
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return jsonResponse({
        id: "pyt_01H",
        payout_id: "PAYOUT-001",
        status: "pending",
        amount: 1000,
        fee: 30,
        net_amount: 970,
        currency: "INR",
        method: "upi",
      });
    },
  });

  assert.equal(request.url, "https://ttpay.business/api/public/v1/payouts");
  assert.equal(request.options.headers["x-api-key"], API_KEY);
  assert.equal(
    request.options.headers["x-signature"],
    computeSunpayPayoutSignature(request.options.body, API_SECRET),
  );

  const body = JSON.parse(request.options.body);
  assert.deepEqual(body, {
    payout_id: "PAYOUT-001",
    amount: 1000,
    currency: "INR",
    method: "upi",
    beneficiary_name: "Trader One",
    beneficiary_account: "trader@upi",
    notify_url: CALLBACK_URL,
  });
  assert.equal(result.status, "PROCESSING");
  assert.equal(result.providerReference, "pyt_01H");
  assert.equal(result.fee, 30);
  assert.equal(result.netAmount, 970);
});

test("Sunpay creates bank payout with IFSC and bank name", async () => {
  let body = null;
  await createSunpayPayout({
    payoutId: "PAYOUT-002",
    amountInr: 5000,
    method: "BANK",
    beneficiaryName: "Trader One",
    beneficiaryAccount: "1234567890",
    ifsc: "hdfc0001234",
    bankName: "HDFC Bank",
  }, {
    baseUrlValue: BASE_URL,
    apiKeyValue: API_KEY,
    apiSecretValue: API_SECRET,
    callbackUrlValue: CALLBACK_URL,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return jsonResponse({
        id: "pyt_02H",
        payout_id: "PAYOUT-002",
        status: "pending",
        amount: 5000,
        currency: "INR",
        method: "bank",
      });
    },
  });

  assert.equal(body.method, "bank");
  assert.equal(body.beneficiary_account, "1234567890");
  assert.equal(body.ifsc, "HDFC0001234");
  assert.equal(body.bank_name, "HDFC Bank");
});

test("Sunpay payout status and balance use payout API key without a body signature", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("/balance")) {
      return jsonResponse({ currency: "INR", balance: 12345.67, upstream_balance: 12100 });
    }
    return jsonResponse({
      id: "pyt_01H",
      payout_id: "PAYOUT-001",
      status: "success",
      amount: 1000,
      net_amount: 970,
      utr: "422519876544",
      settled_at: "2026-07-17T09:33:00Z",
    });
  };

  const status = await getSunpayPayoutStatus("PAYOUT-001", {
    baseUrlValue: BASE_URL,
    apiKeyValue: API_KEY,
    fetchImpl,
  });
  const balance = await getSunpayPayoutBalance("INR", {
    baseUrlValue: BASE_URL,
    apiKeyValue: API_KEY,
    fetchImpl,
  });

  assert.equal(status.status, "PAID");
  assert.equal(status.utr, "422519876544");
  assert.equal(balance.balance, 12345.67);
  assert.equal(requests[0].options.headers["x-signature"], undefined);
  assert.equal(requests[1].options.headers["x-signature"], undefined);
});

test("Sunpay provider statuses map only verified success to PAID", () => {
  assert.equal(normalizeSunpayPayoutStatus("pending"), "PROCESSING");
  assert.equal(normalizeSunpayPayoutStatus("processing"), "PROCESSING");
  assert.equal(normalizeSunpayPayoutStatus("success"), "PAID");
  assert.equal(normalizeSunpayPayoutStatus("failed"), "FAILED");
  assert.equal(normalizeSunpayPayoutStatus("expired"), "FAILED");
});

function payoutModel(initial) {
  let record = { ...initial };

  return {
    get record() { return record; },
    async findOne(query) {
      return query?.payoutId === record.payoutId ? { ...record } : null;
    },
    async findOneAndUpdate(filter, update) {
      if (filter?.payoutId !== record.payoutId) return null;

      const requiredStatus = filter?.status;
      if (typeof requiredStatus === "string" && record.status !== requiredStatus) return null;
      if (requiredStatus?.$in && !requiredStatus.$in.includes(record.status)) return null;

      record = {
        ...record,
        ...(update?.$set || {}),
      };
      return { ...record };
    },
  };
}

test("approved UPI payout executes through Sunpay then remains PROCESSING until status verification succeeds", async () => {
  const model = payoutModel({
    payoutId: "PAYOUT-EXEC-1",
    accountId: "MASTER-1",
    status: "APPROVED",
    activeKey: "MASTER-1",
    method: "UPI",
    settlementCurrency: "INR",
    settlementAmount: 1000,
    destination: { destination: "tr***@upi" },
  });

  const result = await executeApprovedSunpayPayout("PAYOUT-EXEC-1", {
    payoutModel: model,
    now: () => new Date("2026-09-29T20:00:00.000Z"),
    destinationDecryptor: () => ({
      method: "UPI",
      upiId: "trader@upi",
      beneficiaryName: "Trader One",
    }),
    balanceFetcher: async () => ({ currency: "INR", balance: 50000 }),
    payoutCreator: async () => ({
      provider: "sunpay",
      providerReference: "pyt_exec_1",
      payoutId: "PAYOUT-EXEC-1",
      status: "PROCESSING",
      providerStatus: "pending",
      fee: 30,
      netAmount: 970,
    }),
    statusFetcher: async () => ({
      provider: "sunpay",
      providerReference: "pyt_exec_1",
      payoutId: "PAYOUT-EXEC-1",
      status: "PROCESSING",
      providerStatus: "pending",
      fee: 30,
      netAmount: 970,
      utr: null,
      settledAt: null,
    }),
  });

  assert.equal(result.status, "PROCESSING");
  assert.equal(result.provider, "sunpay");
  assert.equal(result.providerReference, "pyt_exec_1");
  assert.equal(result.providerFee, 30);
  assert.equal(result.providerNetAmount, 970);
  assert.equal(result.activeKey, "MASTER-1");
});

test("Sunpay reconciliation marks PAID only after authoritative status endpoint returns success", async () => {
  const model = payoutModel({
    payoutId: "PAYOUT-EXEC-2",
    accountId: "MASTER-2",
    status: "PROCESSING",
    activeKey: "MASTER-2",
    method: "BANK",
    provider: "sunpay",
    providerReference: "pyt_exec_2",
    settlementCurrency: "INR",
    settlementAmount: 5000,
    processingAt: new Date("2026-09-29T20:00:00.000Z"),
  });

  const result = await reconcileSunpayPayout("PAYOUT-EXEC-2", {
    payoutModel: model,
    now: () => new Date("2026-09-29T20:02:00.000Z"),
    statusFetcher: async () => ({
      provider: "sunpay",
      providerReference: "pyt_exec_2",
      payoutId: "PAYOUT-EXEC-2",
      status: "PAID",
      providerStatus: "success",
      fee: 30,
      netAmount: 4970,
      utr: "422519876544",
      settledAt: "2026-09-29T20:01:30.000Z",
    }),
  });

  assert.equal(result.status, "PAID");
  assert.equal(result.activeKey, null);
  assert.equal(result.utr, "422519876544");
  assert.equal(result.providerNetAmount, 4970);
  assert.equal(new Date(result.paidAt).toISOString(), "2026-09-29T20:01:30.000Z");
});

test("insufficient Sunpay balance leaves approved payout reserved for retry", async () => {
  const model = payoutModel({
    payoutId: "PAYOUT-EXEC-3",
    accountId: "MASTER-3",
    status: "APPROVED",
    activeKey: "MASTER-3",
    method: "UPI",
    settlementCurrency: "INR",
    settlementAmount: 1000,
  });

  await assert.rejects(
    () => executeApprovedSunpayPayout("PAYOUT-EXEC-3", {
      payoutModel: model,
      destinationDecryptor: () => ({
        upiId: "trader@upi",
        beneficiaryName: "Trader One",
      }),
      balanceFetcher: async () => ({ currency: "INR", balance: 500 }),
      payoutCreator: async () => {
        throw new Error("should not submit");
      },
    }),
    error => error?.code === "SUNPAY_INSUFFICIENT_BALANCE",
  );

  assert.equal(model.record.status, "APPROVED");
  assert.equal(model.record.activeKey, "MASTER-3");
  assert.equal(model.record.provider, "sunpay");
  assert.equal(model.record.providerLastError.code, "SUNPAY_INSUFFICIENT_BALANCE");
});
