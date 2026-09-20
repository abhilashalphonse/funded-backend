import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import Payment from "../../models/payment.model.js";
import Account from "../../accounts/account.model.js";
import { calculatePrice } from "../../pricing/pricingEngine.js";
import { configuredTradingProvider } from "../../connectors/trading/registry.js";
import { provisionTradingAccount } from "../../connectors/trading/account-provisioning.js";
import { recordAnalyticsEventOnce } from "./analytics.service.js";
import { getOrCreateGuestCustomer, normalizeCustomerEmail } from "../../customers/customer.service.js";
import boss from "../../config/boss.js";
import { enqueuePaymentActivation } from "../../workers/payment-activation.queue.js";
import { ensureTradingCredential } from "../../trading-credentials/trading-credential.service.js";

const NOWPAYMENTS_URL = "https://api.nowpayments.io/v1";
const allowedMethods = { BTC: "btc", USDT_TRX: "usdttrc20" };

function apiKey() {
  if (!process.env.NOWPAYMENTS_API_KEY) throw new Error("NOWPAYMENTS_API_KEY is not configured.");
  return process.env.NOWPAYMENTS_API_KEY;
}

async function nowPayments(path, body) {
  const response = await fetch(`${NOWPAYMENTS_URL}${path}`, {
    method: "POST",
    headers: { "x-api-key": apiKey(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `NOWPayments request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function createCryptoPayment({ email, challengeDefinition, commercialConfig, paymentMethod, customer = null, analyticsSessionId, attribution = {} }) {
  const normalizedEmail = normalizeCustomerEmail(email);
  const fundedCustomer = customer?.customerId
    ? { customerId: customer.customerId, status: customer.status }
    : await getOrCreateGuestCustomer(normalizedEmail);
  if (String(fundedCustomer.status || "").toUpperCase() === "BLOCKED") {
    const error = new Error("This customer account is blocked.");
    error.status = 403;
    error.code = "CUSTOMER_BLOCKED";
    throw error;
  }
  const stableCustomerId = String(fundedCustomer.customerId);
  if (!allowedMethods[paymentMethod]) throw new Error("Unsupported crypto payment method.");
  if (!process.env.NOWPAYMENTS_IPN_URL) throw new Error("NOWPAYMENTS_IPN_URL is not configured.");
  if (!process.env.FRONTEND_URL) throw new Error("FRONTEND_URL is not configured.");

  const pricing = calculatePrice(challengeDefinition, commercialConfig);
  const orderId = `ACG-${randomUUID()}`;
  const payment = await Payment.create({
    orderId,
    ownerExternalRef: stableCustomerId,
    customerId: stableCustomerId,
    email: normalizedEmail,
    challengeDefinition,
    commercialConfig,
    amount: pricing.finalPrice,
    currency: "EUR",
    paymentMethod,
    status: "CREATED",
    metadata: {
      analyticsSessionId: analyticsSessionId ? String(analyticsSessionId) : undefined,
      attribution,
    },
  });

  try {
    const invoice = await nowPayments("/invoice", {
      price_amount: pricing.finalPrice,
      price_currency: "eur",
      pay_currency: allowedMethods[paymentMethod],
      order_id: orderId,
      order_description: `ACG Funded ${challengeDefinition.step} $${challengeDefinition.accountSize.toLocaleString()} challenge`,
      ipn_callback_url: process.env.NOWPAYMENTS_IPN_URL,
      success_url: `${process.env.FRONTEND_URL}/?payment=${payment._id}&status=success`,
      cancel_url: `${process.env.FRONTEND_URL}/?payment=${payment._id}&status=cancelled`,
    });

    payment.providerInvoiceId = String(invoice.id ?? invoice.invoice_id ?? "");
    payment.checkoutUrl = invoice.invoice_url || invoice.payment_url || invoice.pay_address;
    payment.status = "WAITING";
    payment.metadata = {
      ...(payment.metadata || {}),
      pricing,
    };
    await payment.save();
    await recordAnalyticsEventOnce({
      event: "payment_started",
      sessionId: analyticsSessionId || `payment:${payment._id}`,
      email: normalizedEmail,
      paymentId: String(payment._id),
      source: "server",
      attribution,
      properties: {
        amount: pricing.finalPrice,
        currency: "EUR",
        paymentMethod,
        accountSize: challengeDefinition.accountSize,
        step: challengeDefinition.step,
        profitSplit: commercialConfig?.profitSplit,
      },
    }, { paymentId: String(payment._id) }).catch(() => {});
    return { paymentId: payment._id, orderId, amount: pricing.finalPrice, currency: "EUR", checkoutUrl: payment.checkoutUrl };
  } catch (error) {
    payment.status = "FAILED";
    payment.providerStatus = error.message;
    await payment.save();
    throw error;
  }
}

function recursivelySort(value) {
  if (Array.isArray(value)) return value.map(recursivelySort);
  if (value !== null && typeof value === "object") {
    return Object.keys(value).sort().reduce((sorted, key) => {
      sorted[key] = recursivelySort(value[key]);
      return sorted;
    }, {});
  }
  return value;
}

function verifyIpnSignature(payload, signature) {
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!secret || !signature) return false;
  const sortedPayload = recursivelySort(payload);
  const digest = crypto.createHmac("sha512", secret).update(JSON.stringify(sortedPayload)).digest("hex");
  const provided = String(signature).trim().toLowerCase();
  if (digest.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(provided));
}

function buildAccountRules(definition) {
  const rules = definition.rules;
  const phases = definition.step === "2step"
    ? [
        { phase: 1, profitTarget: Number(rules.phase1ProfitTarget) },
        { phase: 2, profitTarget: Number(rules.phase2ProfitTarget) },
      ]
    : [{ phase: 1, profitTarget: Number(rules.profitTarget) }];

  return {
    dailyDrawdown: Number(rules.dailyLoss),
    maxDrawdown: Number(rules.maxLoss),
    minimumTradingDays: Number(rules.minTradingDays),
    phases,
  };
}

export async function activatePaidPayment(payment) {
  if (payment.accountId) {
    if (payment.activation?.status !== "ACTIVE") {
      await Payment.updateOne(
        { _id: payment._id },
        { $set: { "activation.status": "ACTIVE", "activation.error": null } },
      );
    }
    return payment.accountId;
  }

  // Claim activation atomically so duplicate provider IPNs cannot provision twice.
  // A stale PENDING claim may be retried after five minutes in case a worker died.
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 5 * 60 * 1000);
  const claimed = await Payment.findOneAndUpdate(
    {
      _id: payment._id,
      accountId: { $exists: false },
      $or: [
        { "activation.status": { $exists: false } },
        { "activation.status": { $in: ["NOT_STARTED", "FAILED"] } },
        { "activation.status": "PENDING", "activation.attemptedAt": { $lt: staleBefore } },
      ],
    },
    {
      $set: {
        "activation.status": "PENDING",
        "activation.error": null,
        "activation.attemptedAt": now,
      },
    },
    { new: true },
  );

  if (!claimed) {
    const current = await Payment.findById(payment._id).select("accountId activation");
    return current?.accountId || null;
  }

  try {
    const definition = claimed.challengeDefinition;
    const accountId = `ACG-${String(claimed._id).slice(-16).toUpperCase()}`;
    const accountSize = Number(definition.accountSize);
    const rules = buildAccountRules(definition);
    const platform = configuredTradingProvider();

    let account = await Account.findOne({ accountId });
    if (!account) {
      account = await Account.create({
        accountId,
        ownerExternalRef: claimed.ownerExternalRef || claimed.customerId || claimed.email,
        customerId: claimed.customerId || undefined,
        accountMode: "CHALLENGE",
        challengeType: definition.step === "2step" ? "TWO_STEP" : "ONE_STEP",
        accountSize,
        initialDeposit: accountSize,
        currentPhase: 1,
        commercialTerms: {
          profitSplit: Number(claimed.commercialConfig?.profitSplit ?? 80),
          payoutFrequency: claimed.commercialConfig?.payoutFrequency || "Biweekly",
          newsTrading: Boolean(claimed.commercialConfig?.newsTrading),
          weekendHolding: Boolean(claimed.commercialConfig?.weekendHolding),
        },
        rules,
        leverage: 100,
        platform,
        status: "NEW",
        enabled: false,
        balance: accountSize,
        equity: accountSize,
        dailyStartEquity: accountSize,
      });
    }

    if (account.provisioning?.status !== "ACTIVE" || !account.platformAccountId) {
      await provisionTradingAccount(account, { phase: 1, accountType: "CHALLENGE" });
    }

    account.status = "ACTIVE";
    account.enabled = true;
    await account.save();

    // Credential delivery is additive to account activation. If the credential
    // feature is not configured yet, the challenge still activates and can be
    // opened through the existing federated ACG Trader launch flow.
    await ensureTradingCredential(account, { email: claimed.email, queueEmail: true, platformAccountId: account.platformAccountId });

    const activatedAt = new Date();
    await Payment.updateOne(
      { _id: claimed._id },
      {
        $set: {
          accountId: account.accountId,
          activatedAt,
          "activation.status": "ACTIVE",
          "activation.error": null,
        },
      },
    );
    return account.accountId;
  } catch (error) {
    await Payment.updateOne(
      { _id: claimed._id },
      {
        $set: {
          "activation.status": "FAILED",
          "activation.error": String(error?.message || "Trading account activation failed").slice(0, 1000),
        },
      },
    );
    throw error;
  }
}

export async function processIpn(payload, signature) {
  if (!verifyIpnSignature(payload, signature)) {
    const error = new Error("Invalid NOWPayments IPN signature.");
    error.status = 401;
    throw error;
  }

  const payment = await Payment.findOne({ orderId: payload.order_id });
  if (!payment) { const error = new Error("Payment order not found."); error.status = 404; throw error; }

  const expectedCrypto = allowedMethods[payment.paymentMethod];
  const expectedFiat = Number(payment.amount);
  const receivedFiat = Number(payload.price_amount);
  if (payload.price_currency && String(payload.price_currency).toLowerCase() !== "eur") throw new Error("Unexpected payment fiat currency.");
  if (Number.isFinite(receivedFiat) && Math.abs(receivedFiat - expectedFiat) > 0.01) throw new Error("Payment amount mismatch.");
  if (payload.pay_currency && String(payload.pay_currency).toLowerCase() !== expectedCrypto) throw new Error("Payment cryptocurrency mismatch.");

  payment.providerPaymentId = payload.payment_id ? String(payload.payment_id) : payment.providerPaymentId;
  payment.providerStatus = payload.payment_status;
  payment.paidAmount = Number(payload.actually_paid ?? payload.pay_amount ?? 0);
  payment.paidCurrency = payload.pay_currency;

  const nextStatus = ({
    waiting: "WAITING",
    confirming: "CONFIRMING",
    confirmed: "PAID",
    finished: "PAID",
    failed: "FAILED",
    expired: "EXPIRED",
    partially_paid: "UNDERPAID",
    refunded: "REFUNDED",
  })[payload.payment_status];
  if (nextStatus) payment.status = nextStatus;
  if (payment.status === "PAID" && !payment.paidAt) payment.paidAt = new Date();
  await payment.save();

  if (payment.status === "PAID") {
    await recordAnalyticsEventOnce({
      event: "payment_completed",
      sessionId: payment.metadata?.analyticsSessionId || `payment:${payment._id}`,
      email: payment.email,
      paymentId: String(payment._id),
      source: "server",
      attribution: payment.metadata?.attribution || {},
      properties: { amount: payment.amount, currency: payment.currency },
    }, { paymentId: String(payment._id) }).catch(() => {});

    await enqueuePaymentActivation(boss, payment._id);
  }
  return payment;
}

export async function getPaymentStatus(id) {
  const payment = await Payment.findById(id).select("orderId status amount currency checkoutUrl providerStatus paidAmount paidCurrency paidAt accountId activatedAt activation");
  if (!payment) { const error = new Error("Payment not found."); error.status = 404; throw error; }
  return payment;
}
