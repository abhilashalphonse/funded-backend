import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import Payment from "../src/models/payment.model.js";
import Account from "../src/accounts/account.model.js";
import Customer from "../src/customers/customer.model.js";
import AnalyticsEvent from "../src/models/analyticsEvent.model.js";
import boss from "../src/config/boss.js";
import { processIpn, activatePaidPayment, assertConfirmedCheckoutPrice } from "../src/apis/services/payment.service.js";
import { calculatePrice } from "../src/pricing/pricingEngine.js";
import { clearTradingConnectorRegistry, registerTradingConnector } from "../src/connectors/trading/registry.js";

// Provider, queue and persistence are replaced with in-memory adapters. The
// actual signed callback, payment state machine, activation implementation and
// risk-policy/provisioning mapper execute; no payment API or database is used.
async function withSandbox(t, step) {
  const oldSecret = process.env.NOWPAYMENTS_IPN_SECRET;
  const oldProvider = process.env.TRADING_PROVIDER;
  process.env.NOWPAYMENTS_IPN_SECRET = "integration-test-only-webhook-secret";
  process.env.TRADING_PROVIDER = "simulator";
  t.after(() => {
    if (oldSecret === undefined) delete process.env.NOWPAYMENTS_IPN_SECRET;
    else process.env.NOWPAYMENTS_IPN_SECRET = oldSecret;
    if (oldProvider === undefined) delete process.env.TRADING_PROVIDER;
    else process.env.TRADING_PROVIDER = oldProvider;
    clearTradingConnectorRegistry();
  });

  const definition = step === "2step"
    ? { step, accountSize: 50000, rules: { phase1ProfitTarget: 12, phase2ProfitTarget: 11, dailyLoss: 3, maxLoss: 8, minTradingDays: 4 } }
    : { step, accountSize: 50000, rules: { profitTarget: 12, dailyLoss: 3, maxLoss: 8, minTradingDays: 4 } };
  const commercial = { profitSplit: 60, payoutFrequency: "Monthly", newsTrading: false, weekendHolding: true };
  const price = calculatePrice(definition, commercial);
  const payment = {
    _id: "0123456789abcdef01234567",
    orderId: "ACG-INTEGRATION-001",
    email: "fixture@example.invalid",
    paymentMethod: "BTC",
    provider: "nowpayments",
    providerCurrency: "USD",
    currency: "USD",
    amount: price.finalPrice,
    status: "WAITING",
    challengeDefinition: structuredClone(definition),
    commercialConfig: structuredClone(commercial),
    activation: { status: "NOT_STARTED" },
    metadata: { pricingVersion: price.pricingVersion },
    async save() { return this; },
  };
  const calls = { queued: [], provisioned: [], created: [], updates: [] };
  // Keep analytics observational and deterministic; no Mongo connection wait.
  t.mock.method(Customer, "findOne", () => ({
    select: () => ({ lean: async () => null }),
  }));
  t.mock.method(AnalyticsEvent, "findOne", () => ({
    select: () => ({ lean: async () => null }),
    lean: async () => null,
  }));
  t.mock.method(AnalyticsEvent, "create", async data => data);

  let account = null;

  t.mock.method(Payment, "findOne", async ({ orderId }) => orderId === payment.orderId ? payment : null);
  t.mock.method(Payment, "findOneAndUpdate", async () => {
    if (payment.accountId || payment.activation.status === "PENDING") return null;
    payment.activation.status = "PENDING";
    return payment;
  });
  t.mock.method(Payment, "updateOne", async (_filter, update) => {
    calls.updates.push(update.$set);
    for (const [key, value] of Object.entries(update.$set || {})) {
      const target = key.split(".");
      if (target.length === 1) payment[key] = value;
      else {
        payment[target[0]] ??= {};
        payment[target[0]][target[1]] = value;
      }
    }
    return { matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(Account, "findOne", async () => account);
  t.mock.method(Account, "create", async values => {
    calls.created.push(values);
    account = {
      ...structuredClone(values),
      _id: "fake-account-mongo-id",
      platformAccounts: [],
      provisioning: { status: "NOT_STARTED" },
      async save() { return this; },
    };
    return account;
  });
  t.mock.method(boss, "send", async (queue, payload) => {
    calls.queued.push({ queue, payload });
    return "test-queue-job";
  });
  registerTradingConnector("simulator", {
    async provisionAccount(payload) {
      calls.provisioned.push(payload);
      return { platformAccountId: "SIM-INTEGRATION-1", raw: { status: "ACTIVE" } };
    },
  });
  const callback = {
    order_id: payment.orderId,
    payment_id: "provider-payment-abc",
    payment_status: "finished",
    price_amount: price.finalPrice,
    price_currency: "usd",
    pay_currency: "btc",
    actually_paid: 0.004,
  };
  const sign = body => crypto.createHmac("sha512", process.env.NOWPAYMENTS_IPN_SECRET)
    .update(JSON.stringify(Object.fromEntries(Object.entries(body).sort(([a],[b]) => a.localeCompare(b)))))
    .digest("hex");
  return { definition, commercial, price, payment, calls, callback, sign, getAccount: () => account };
}

for (const step of ["1step", "2step"]) {
  test(`signed crypto provider settlement provisions exactly one purchased ${step} account`, async t => {
    const x = await withSandbox(t, step);
    // The payment requires an explicit confirmed current V3 quote.
    assert.doesNotThrow(() => assertConfirmedCheckoutPrice(x.price, {
      confirmedPrice: x.price.finalPrice, confirmedPricingVersion: x.price.pricingVersion,
    }));
    assert.throws(() => assertConfirmedCheckoutPrice(x.price, {
      confirmedPrice: x.price.finalPrice, confirmedPricingVersion: "2026-10-challenge-v2",
    }), { code: "CHECKOUT_PRICE_CHANGED", status: 409 });

    const callback = x.callback;
    await assert.rejects(() => processIpn(callback, "invalid-signature"), { status: 401 });
    assert.equal(x.payment.status, "WAITING");
    assert.equal(x.calls.queued.length, 0);

    const tampered = { ...callback, price_amount: x.price.finalPrice + 1 };
    await assert.rejects(() => processIpn(tampered, x.sign(tampered)), /amount mismatch/i);
    assert.equal(x.payment.status, "WAITING");
    assert.equal(x.calls.queued.length, 0);

    await processIpn(callback, x.sign(callback));
    assert.equal(x.payment.status, "PAID");
    assert.equal(x.calls.queued.length, 1);
    assert.equal(x.calls.queued[0].queue, "payment-activation");
    await processIpn(callback, x.sign(callback));
    assert.equal(x.calls.queued.length, 1, "duplicate settled callback never enqueues activation twice");

    const accountId = await activatePaidPayment(x.payment);
    const account = x.getAccount();
    assert.equal(account.accountId, accountId);
    assert.equal(x.payment.accountId, accountId);
    assert.equal(x.payment.activation.status, "ACTIVE");
    assert.equal(x.calls.created.length, 1);
    assert.equal(x.calls.provisioned.length, 1);
    assert.equal(x.calls.provisioned[0].activate, true);
    assert.equal(account.status, "ACTIVE");
    assert.equal(account.enabled, true);
    assert.equal(account.rules.dailyDrawdown, x.definition.rules.dailyLoss);
    assert.equal(account.rules.maxDrawdown, x.definition.rules.maxLoss);
    assert.equal(account.rules.minimumTradingDays, x.definition.rules.minTradingDays);
    assert.equal(account.rules.phases[0].profitTarget, step === "2step" ? x.definition.rules.phase1ProfitTarget : x.definition.rules.profitTarget);
    if (step === "2step") assert.equal(account.rules.phases[1].profitTarget, x.definition.rules.phase2ProfitTarget);
    assert.deepEqual(account.commercialTerms, {
      profitSplit: 60, payoutFrequency: "Monthly", newsTrading: false, weekendHolding: true,
    });
    assert.equal(x.calls.provisioned[0].tradingPermissions.newsTrading, false);
    assert.equal(x.calls.provisioned[0].tradingPermissions.weekendHolding, true);
    const second = await activatePaidPayment(x.payment);
    assert.equal(second, accountId);
    assert.equal(x.calls.provisioned.length, 1, "repeated activation does not reprovision");
    assert.equal(x.calls.created.length, 1);
  });
}

test("activation refuses paid records missing explicit purchased permissions", async t => {
  const x = await withSandbox(t, "2step");
  await processIpn(x.callback, x.sign(x.callback));
  delete x.payment.commercialConfig.newsTrading;
  await assert.rejects(() => activatePaidPayment(x.payment), { code: "PROVISIONING_CONTRACT_INVALID" });
  assert.equal(x.payment.activation.status, "FAILED");
  assert.equal(x.calls.provisioned.length, 0);
  assert.equal(x.payment.accountId, undefined);
});
