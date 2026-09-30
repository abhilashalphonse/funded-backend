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
const WEBHOOK_SECRET = "shared-webhook-secret";
const BASE_URL = "https://ttpay.business";
const CALLBACK_URL = "https://example.com/api/webhooks/payouts/sunpay";

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
  };
}

test("Sunpay payout requests use the payout API secret while callbacks use the shared webhook secret", () => {
  const raw = Buffer.from('{"payout_id":"PO_001","amount":1000}', "utf8");
  const requestSignature = computeSunpayPayoutSignature(raw, API_SECRET);
  const webhookSignature = computeSunpayPayoutSignature(raw, WEBHOOK_SECRET);

  assert.match(requestSignature, /^[0-9a-f]{64}$/);
  assert.equal(verifySunpayPayoutWebhook(raw, webhookSignature, WEBHOOK_SECRET), true);
  assert.equal(verifySunpayPayoutWebhook(raw, requestSignature, WEBHOOK_SECRET), false);
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

test("direct approved Sunpay execution is hard-blocked while automatic provider readiness is disabled", async () => {
  const model = payoutModel({
    payoutId: "PAYOUT-GUARD",
    accountId: "MASTER-GUARD",
    status: "APPROVED",
    activeKey: "MASTER-GUARD",
    method: "UPI",
    settlementCurrency: "INR",
    settlementAmount: 1000,
  });
  let balanceCalls = 0;
  let createCalls = 0;

  await assert.rejects(
    () => executeApprovedSunpayPayout("PAYOUT-GUARD", {
      payoutModel: model,
      destinationDecryptor: () => ({
        upiId: "trader@upi",
        beneficiaryName: "Trader One",
      }),
      balanceFetcher: async () => {
        balanceCalls += 1;
        return { currency: "INR", balance: 50000 };
      },
      payoutCreator: async () => {
        createCalls += 1;
        return {};
      },
    }),
    error => error?.code === "PAYOUT_AUTOMATIC_EXECUTION_DISABLED",
  );

  assert.equal(balanceCalls, 0);
  assert.equal(createCalls, 0);
  assert.equal(model.record.status, "APPROVED");
  assert.equal(model.record.activeKey, "MASTER-GUARD");
});

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
    executionGuard: () => true,
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
      amount: 1000,
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
  assert.equal(result.providerGrossAmount, 1000);
  assert.equal(result.providerNetAmount, 970);
  assert.equal(result.activeKey, "MASTER-1");
});

test("Sunpay reconciliation marks PAID only when provider success delivered the full quoted trader amount", async () => {
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
    feePolicy: "ACG_COVERS",
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
      amount: 5030,
      fee: 30,
      netAmount: 5000,
      utr: "422519876544",
      settledAt: "2026-09-29T20:01:30.000Z",
    }),
  });

  assert.equal(result.status, "PAID");
  assert.equal(result.activeKey, null);
  assert.equal(result.utr, "422519876544");
  assert.equal(result.providerGrossAmount, 5030);
  assert.equal(result.providerNetAmount, 5000);
  assert.equal(result.traderReceivedAmount, 5000);
  assert.equal(result.providerFeePaidByAcg, 30);
  assert.equal(result.acgTotalCostAmount, 5030);
  assert.equal(result.accountingSource, "PROVIDER_VERIFIED");
  assert.equal(new Date(result.paidAt).toISOString(), "2026-09-29T20:01:30.000Z");
});

test("Sunpay success with a fee-deducted net amount stays PROCESSING for an ACG top-up", async () => {
  const model = payoutModel({
    payoutId: "PAYOUT-EXEC-SHORT",
    accountId: "MASTER-SHORT",
    status: "PROCESSING",
    activeKey: "MASTER-SHORT",
    method: "UPI",
    provider: "sunpay",
    providerReference: "pyt_short",
    settlementCurrency: "INR",
    settlementAmount: 1000,
    feePolicy: "ACG_COVERS",
    processingAt: new Date("2026-09-29T20:00:00.000Z"),
  });

  const result = await reconcileSunpayPayout("PAYOUT-EXEC-SHORT", {
    payoutModel: model,
    now: () => new Date("2026-09-29T20:02:00.000Z"),
    statusFetcher: async () => ({
      provider: "sunpay",
      providerReference: "pyt_short",
      payoutId: "PAYOUT-EXEC-SHORT",
      status: "PAID",
      providerStatus: "success",
      amount: 1000,
      fee: 30,
      netAmount: 970,
      utr: "422519876500",
      settledAt: "2026-09-29T20:01:30.000Z",
    }),
  });

  assert.equal(result.status, "PROCESSING");
  assert.equal(result.activeKey, "MASTER-SHORT");
  assert.equal(result.providerGrossAmount, 1000);
  assert.equal(result.providerNetAmount, 970);
  assert.equal(result.traderReceivedAmount, undefined);
  assert.equal(result.providerLastError.code, "PAYOUT_EXACT_RECEIPT_MISMATCH");
  assert.equal(result.providerLastError.expectedAmount, 1000);
  assert.equal(result.providerLastError.receivedAmount, 970);
  assert.equal(result.providerLastError.currency, "INR");
});

test("a restart during PROCESSING reconciles status without creating a second provider payout", async () => {
  const model = payoutModel({
    payoutId: "PAYOUT-RESTART",
    accountId: "MASTER-RESTART",
    status: "PROCESSING",
    activeKey: "MASTER-RESTART",
    method: "UPI",
    provider: "sunpay",
    settlementCurrency: "INR",
    settlementAmount: 1000,
    feePolicy: "ACG_COVERS",
  });
  let createCalls = 0;
  let statusCalls = 0;

  const result = await executeApprovedSunpayPayout("PAYOUT-RESTART", {
    payoutModel: model,
    payoutCreator: async () => {
      createCalls += 1;
      throw new Error("must not create a second payout");
    },
    statusFetcher: async () => {
      statusCalls += 1;
      return {
        provider: "sunpay",
        payoutId: "PAYOUT-RESTART",
        status: "PROCESSING",
        providerStatus: "processing",
        amount: 1000,
        fee: 30,
        netAmount: 970,
      };
    },
  });

  assert.equal(result.status, "PROCESSING");
  assert.equal(createCalls, 0);
  assert.equal(statusCalls, 1);
});

test("Sunpay provider failure releases the payout reservation for a future request", async () => {
  const model = payoutModel({
    payoutId: "PAYOUT-FAILED",
    accountId: "MASTER-FAILED",
    status: "PROCESSING",
    activeKey: "MASTER-FAILED",
    method: "UPI",
    provider: "sunpay",
    settlementCurrency: "INR",
    settlementAmount: 1000,
  });

  const result = await reconcileSunpayPayout("PAYOUT-FAILED", {
    payoutModel: model,
    statusFetcher: async () => ({
      provider: "sunpay",
      payoutId: "PAYOUT-FAILED",
      status: "FAILED",
      providerStatus: "failed",
      amount: 1000,
      fee: 30,
      netAmount: 970,
    }),
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.activeKey, null);
  assert.equal(result.failure.code, "SUNPAY_PROVIDER_FAILED");
});

test("Sunpay status timeout keeps the payout reserved and records a retryable provider error", async () => {
  const model = payoutModel({
    payoutId: "PAYOUT-TIMEOUT",
    accountId: "MASTER-TIMEOUT",
    status: "PROCESSING",
    activeKey: "MASTER-TIMEOUT",
    method: "BANK",
    provider: "sunpay",
    settlementCurrency: "INR",
    settlementAmount: 5000,
  });
  const timeout = new Error("provider timeout");
  timeout.code = "SUNPAY_TIMEOUT";
  timeout.status = 504;

  await assert.rejects(
    () => reconcileSunpayPayout("PAYOUT-TIMEOUT", {
      payoutModel: model,
      statusFetcher: async () => { throw timeout; },
    }),
    error => error?.code === "SUNPAY_TIMEOUT",
  );

  assert.equal(model.record.status, "PROCESSING");
  assert.equal(model.record.activeKey, "MASTER-TIMEOUT");
  assert.equal(model.record.providerLastError.code, "SUNPAY_TIMEOUT");
  assert.equal(model.record.providerLastError.status, 504);
});

test("repeated reconciliation after PAID is idempotent and does not query Sunpay again", async () => {
  const model = payoutModel({
    payoutId: "PAYOUT-PAID-IDEMPOTENT",
    accountId: "MASTER-PAID",
    status: "PAID",
    activeKey: null,
    method: "UPI",
    provider: "sunpay",
    settlementCurrency: "INR",
    settlementAmount: 1000,
    traderReceivedAmount: 1000,
    providerFeePaidByAcg: 30,
    acgTotalCostAmount: 1030,
  });
  let statusCalls = 0;

  const result = await reconcileSunpayPayout("PAYOUT-PAID-IDEMPOTENT", {
    payoutModel: model,
    statusFetcher: async () => {
      statusCalls += 1;
      throw new Error("must not query a terminal payout");
    },
  });

  assert.equal(result.status, "PAID");
  assert.equal(statusCalls, 0);
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
      executionGuard: () => true,
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
