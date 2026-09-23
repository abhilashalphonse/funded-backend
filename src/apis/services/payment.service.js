import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import Payment from "../../models/payment.model.js";
import Account from "../../accounts/account.model.js";
import Customer from "../../customers/customer.model.js";
import { calculatePrice } from "../../pricing/pricingEngine.js";
import { configuredTradingProvider } from "../../connectors/trading/registry.js";
import { activateTradingAccount, provisionTradingAccount, stageTradingAccount } from "../../connectors/trading/account-provisioning.js";
import { recordAnalyticsEventOnce } from "./analytics.service.js";
import { getOrCreateGuestCustomer, normalizeCustomerEmail } from "../../customers/customer.service.js";
import boss from "../../config/boss.js";
import { enqueuePaymentActivation } from "../../workers/payment-activation.queue.js";
import { ensureTradingCredential } from "../../trading-credentials/trading-credential.service.js";
import { usdToInrQuote } from "./paymentProviders/upiFx.service.js";
import {
  DEFAULT_UPI_GATEWAY_ID,
  getActiveUpiGateway,
  getUpiGateway,
  normalizeUpiGatewayId,
} from "./paymentProviders/upiGateway.registry.js";

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

const UPI_QUOTE_TTL_MS = 10 * 60 * 1000;
const UPI_PROVIDER_POLL_INTERVAL_MS = 15 * 1000;

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function createStatusToken() {
  const token = crypto.randomBytes(24).toString("base64url");
  return { token, hash: hashToken(token) };
}

function safeStringEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function upiQuoteSecret(gateway) {
  const secret = String(gateway?.quoteSecret?.() || "").trim();
  if (!secret) {
    const error = new Error("UPI payment gateway is not configured.");
    error.status = 503;
    error.code = "UPI_GATEWAY_NOT_CONFIGURED";
    throw error;
  }
  return secret;
}

function pricingFingerprint(challengeDefinition, commercialConfig) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(recursivelySort({ challengeDefinition, commercialConfig })))
    .digest("hex");
}

function signUpiQuote(payload, gateway) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", upiQuoteSecret(gateway)).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyUpiQuoteToken(token, challengeDefinition, commercialConfig) {
  const [encoded, signature] = String(token || "").split(".");
  if (!encoded || !signature) {
    const error = new Error("A valid UPI quote is required.");
    error.status = 400;
    error.code = "UPI_QUOTE_REQUIRED";
    throw error;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    const error = new Error("UPI quote is invalid.");
    error.status = 400;
    error.code = "UPI_QUOTE_INVALID";
    throw error;
  }

  const gateway = getUpiGateway(payload?.gatewayId || DEFAULT_UPI_GATEWAY_ID);
  const expected = crypto.createHmac("sha256", upiQuoteSecret(gateway)).update(encoded).digest("base64url");
  if (!safeStringEqual(signature, expected)) {
    const error = new Error("UPI quote verification failed.");
    error.status = 400;
    error.code = "UPI_QUOTE_INVALID";
    throw error;
  }

  if (!Number.isFinite(Number(payload?.expiresAt)) || Number(payload.expiresAt) < Date.now()) {
    const error = new Error("UPI quote has expired. Refresh the checkout amount and try again.");
    error.status = 409;
    error.code = "UPI_QUOTE_EXPIRED";
    throw error;
  }

  const expectedFingerprint = pricingFingerprint(challengeDefinition, commercialConfig);
  if (!safeStringEqual(payload?.fingerprint, expectedFingerprint)) {
    const error = new Error("UPI quote does not match this challenge configuration.");
    error.status = 409;
    error.code = "UPI_QUOTE_MISMATCH";
    throw error;
  }

  return payload;
}

export function nextPaymentStatus(currentStatus, requestedStatus) {
  const current = String(currentStatus || "CREATED").toUpperCase();
  const next = String(requestedStatus || current).toUpperCase();

  if (current === "REFUNDED") return "REFUNDED";
  if (current === "PAID") return next === "REFUNDED" ? "REFUNDED" : "PAID";
  if (next === "PAID" || next === "REFUNDED") return next;

  const progress = { CREATED: 0, WAITING: 1, CONFIRMING: 2 };
  if (progress[current] != null && progress[next] != null) {
    return progress[next] >= progress[current] ? next : current;
  }

  if (["FAILED", "EXPIRED", "UNDERPAID"].includes(current) && ["CREATED", "WAITING", "CONFIRMING"].includes(next)) {
    return current;
  }

  return next;
}


export async function getUpiQuote({ challengeDefinition, commercialConfig }) {
  const gateway = await getActiveUpiGateway();
  const pricing = calculatePrice(challengeDefinition, commercialConfig);
  const fx = await usdToInrQuote(pricing.finalPrice);
  const providerAmount = fx.amountInr;
  if (providerAmount < 1 || providerAmount > 100000) {
    const error = new Error("This challenge price is outside the supported UPI payment range.");
    error.status = 400;
    error.code = "UPI_AMOUNT_OUT_OF_RANGE";
    throw error;
  }

  const expiresAt = Date.now() + UPI_QUOTE_TTL_MS;
  const quoteToken = signUpiQuote({
    gatewayId: gateway.id,
    fingerprint: pricingFingerprint(challengeDefinition, commercialConfig),
    amount: pricing.finalPrice,
    currency: "USD",
    providerAmount,
    providerCurrency: "INR",
    usdToInr: fx.usdToInr,
    quoteDate: fx.quoteDate,
    expiresAt,
  }, gateway);

  return {
    amount: pricing.finalPrice,
    currency: "USD",
    providerAmount,
    providerCurrency: "INR",
    paymentMethod: "UPI",
    gatewayId: gateway.id,
    quoteToken,
    expiresAt,
    fx: {
      source: fx.source,
      quoteDate: fx.quoteDate,
      baseCurrency: fx.baseCurrency,
      quoteCurrency: fx.quoteCurrency,
      usdToInr: fx.usdToInr,
    },
  };
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
  const statusAccess = createStatusToken();
  const payment = await Payment.create({
    orderId,
    ownerExternalRef: stableCustomerId,
    customerId: stableCustomerId,
    email: normalizedEmail,
    challengeDefinition,
    commercialConfig,
    amount: pricing.finalPrice,
    currency: "USD",
    paymentMethod,
    statusTokenHash: statusAccess.hash,
    status: "CREATED",
    metadata: {
      analyticsSessionId: analyticsSessionId ? String(analyticsSessionId) : undefined,
      attribution,
    },
  });

  try {
    const invoice = await nowPayments("/invoice", {
      price_amount: pricing.finalPrice,
      price_currency: "usd",
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
        currency: "USD",
        paymentMethod,
        accountSize: challengeDefinition.accountSize,
        step: challengeDefinition.step,
        profitSplit: commercialConfig?.profitSplit,
      },
    }, { paymentId: String(payment._id) }).catch(() => {});

    return {
      paymentId: payment._id,
      statusToken: statusAccess.token,
      orderId,
      amount: pricing.finalPrice,
      currency: "USD",
      checkoutUrl: payment.checkoutUrl,
    };
  } catch (error) {
    payment.status = "FAILED";
    payment.providerStatus = error.message;
    await payment.save();
    throw error;
  }
}

export async function createUpiPayment({
  email,
  challengeDefinition,
  commercialConfig,
  customer = null,
  analyticsSessionId,
  attribution = {},
  customerMobile,
  quoteToken,
}) {
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
  const pricing = calculatePrice(challengeDefinition, commercialConfig);
  const quote = verifyUpiQuoteToken(quoteToken, challengeDefinition, commercialConfig);
  const gateway = getUpiGateway(quote.gatewayId || DEFAULT_UPI_GATEWAY_ID);
  const callbackUrl = gateway.callbackUrl?.();
  if (!callbackUrl) {
    const error = new Error("UPI payment callback is not configured.");
    error.status = 503;
    error.code = "UPI_GATEWAY_NOT_CONFIGURED";
    throw error;
  }
  const providerAmount = Number(quote.providerAmount);

  if (
    String(quote.currency).toUpperCase() !== "USD"
    || String(quote.providerCurrency).toUpperCase() !== "INR"
    || Math.abs(Number(quote.amount) - Number(pricing.finalPrice)) > 0.01
  ) {
    const error = new Error("UPI quote does not match the current challenge price.");
    error.status = 409;
    error.code = "UPI_QUOTE_MISMATCH";
    throw error;
  }

  if (!Number.isFinite(providerAmount) || providerAmount < 1 || providerAmount > 100000) {
    const error = new Error("This challenge price is outside the supported UPI payment range.");
    error.status = 400;
    error.code = "UPI_AMOUNT_OUT_OF_RANGE";
    throw error;
  }

  const orderId = `ACG-${randomUUID()}`;
  const statusAccess = createStatusToken();
  const payment = await Payment.create({
    orderId,
    ownerExternalRef: stableCustomerId,
    customerId: stableCustomerId,
    email: normalizedEmail,
    challengeDefinition,
    commercialConfig,
    amount: pricing.finalPrice,
    currency: "USD",
    providerAmount,
    providerCurrency: "INR",
    paymentMethod: "UPI",
    provider: gateway.id,
    statusTokenHash: statusAccess.hash,
    status: "CREATED",
    metadata: {
      analyticsSessionId: analyticsSessionId ? String(analyticsSessionId) : undefined,
      attribution,
      pricing,
      fx: {
        source: "daily-fx",
        quoteDate: quote.quoteDate,
        baseCurrency: "USD",
        quoteCurrency: "INR",
        usdToInr: Number(quote.usdToInr),
      },
      quoteExpiresAt: new Date(Number(quote.expiresAt)).toISOString(),
    },
  });

  try {
    const order = await gateway.createOrder({
      amountInr: providerAmount,
      orderId,
      redirectUrl: callbackUrl,
      customerMobile,
      customerEmail: normalizedEmail,
      paymentId: payment._id,
      remark1: `ACG Funded ${challengeDefinition.step} ${Number(challengeDefinition.accountSize).toLocaleString()} challenge`,
    });

    payment.checkoutUrl = order.checkoutUrl;
    payment.providerStatus = "PENDING";
    payment.status = "WAITING";
    payment.metadata = {
      ...(payment.metadata || {}),
      providerCreateAcknowledged: true,
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
        currency: "USD",
        providerAmount,
        providerCurrency: "INR",
        paymentMethod: "UPI",
        gatewayId: gateway.id,
        accountSize: challengeDefinition.accountSize,
        step: challengeDefinition.step,
        profitSplit: commercialConfig?.profitSplit,
      },
    }, { paymentId: String(payment._id) }).catch(() => {});

    return {
      paymentId: payment._id,
      statusToken: statusAccess.token,
      orderId,
      amount: pricing.finalPrice,
      currency: "USD",
      providerAmount,
      providerCurrency: "INR",
      checkoutUrl: payment.checkoutUrl,
    };
  } catch (error) {
    payment.status = "FAILED";
    payment.providerStatus = error.message;
    await payment.save();
    throw error;
  }
}

async function markUpiPayment(payment, providerData) {
  const gateway = getUpiGateway(payment.provider || DEFAULT_UPI_GATEWAY_ID);
  const returnedOrderId = String(providerData?.order_id || "").trim();
  if (returnedOrderId && returnedOrderId !== payment.orderId) {
    const error = new Error("UPI order ID mismatch.");
    error.status = 400;
    error.code = "UPI_ORDER_MISMATCH";
    throw error;
  }

  const expectedAmount = Number(payment.providerAmount);
  const returnedAmount = Number(providerData?.amount);
  const providerPaymentStatus = String(providerData?.payment_status || providerData?.status || "").trim().toUpperCase();
  const returnedMethod = String(providerData?.method || "").trim().toUpperCase();
  const returnedCurrency = String(providerData?.currency || "").trim().toUpperCase();

  if (providerPaymentStatus === "SUCCESS" && returnedMethod !== "UPI") {
    const error = new Error("Unexpected UPI payment method.");
    error.status = 400;
    error.code = "UPI_METHOD_MISMATCH";
    throw error;
  }
  if (returnedCurrency && returnedCurrency !== "INR") {
    const error = new Error("Unexpected UPI settlement currency.");
    error.status = 400;
    error.code = "UPI_CURRENCY_MISMATCH";
    throw error;
  }
  if (!Number.isFinite(returnedAmount) || Math.abs(returnedAmount - expectedAmount) > 0.01) {
    const error = new Error("UPI payment amount mismatch.");
    error.status = 400;
    error.code = "UPI_AMOUNT_MISMATCH";
    throw error;
  }

  const previousStatus = payment.status;
  const requestedStatus = gateway.normalizeStatus(providerData?.payment_status || providerData?.status);
  const nextStatus = nextPaymentStatus(previousStatus, requestedStatus);
  const becamePaid = previousStatus !== "PAID" && nextStatus === "PAID";

  payment.providerStatus = String(providerData?.payment_status || providerData?.status || "");
  payment.providerLastCheckedAt = new Date();
  payment.utr = providerData?.utr ? String(providerData.utr) : payment.utr;
  if (providerData?.payment_token || providerData?.id) {
    payment.providerPaymentId = String(providerData.payment_token || providerData.id);
  }
  payment.status = nextStatus;

  if (nextStatus === "PAID") {
    payment.paidAmount = returnedAmount;
    payment.paidCurrency = "INR";
    if (!payment.paidAt) payment.paidAt = new Date();
  }

  await payment.save();

  if (becamePaid) {
    await recordAnalyticsEventOnce({
      event: "payment_completed",
      sessionId: payment.metadata?.analyticsSessionId || `payment:${payment._id}`,
      email: payment.email,
      paymentId: String(payment._id),
      source: "server",
      attribution: payment.metadata?.attribution || {},
      properties: {
        amount: payment.amount,
        currency: "USD",
        providerAmount: payment.providerAmount,
        providerCurrency: "INR",
        method: "UPI",
      },
    }, { paymentId: String(payment._id) }).catch(() => {});

    await enqueuePaymentActivation(boss, payment._id);
  }

  return payment;
}

export async function refreshUpiPayment(payment, { force = false } = {}) {
  if (!payment || payment.paymentMethod !== "UPI") return payment;
  if (["PAID", "REFUNDED"].includes(payment.status)) return payment;

  const gateway = getUpiGateway(payment.provider || DEFAULT_UPI_GATEWAY_ID);
  if (!gateway.supportsStatusPolling || typeof gateway.getOrderStatus !== "function") {
    return payment;
  }

  const lastCheckedAt = payment.providerLastCheckedAt ? new Date(payment.providerLastCheckedAt).getTime() : 0;
  if (!force && lastCheckedAt && Date.now() - lastCheckedAt < UPI_PROVIDER_POLL_INTERVAL_MS) {
    return payment;
  }

  payment.providerLastCheckedAt = new Date();
  await payment.save();

  const providerData = await gateway.getOrderStatus(payment.orderId);
  return markUpiPayment(payment, providerData);
}

export async function processUpiCallback(
  payload = {},
  callbackGatewayId = DEFAULT_UPI_GATEWAY_ID,
  { rawBody = null, signature = null } = {},
) {
  const orderId = String(payload?.order_id || "").trim();
  if (!orderId) {
    const error = new Error("UPI callback is missing order_id.");
    error.status = 400;
    error.code = "UPI_ORDER_ID_REQUIRED";
    throw error;
  }

  const callbackGateway = getUpiGateway(callbackGatewayId);

  if (callbackGateway.id === "sunpay" && payload?.event && payload.event !== "payin.updated") {
    const error = new Error("Unexpected Sunpay webhook event.");
    error.status = 400;
    error.code = "SUNPAY_WEBHOOK_EVENT_INVALID";
    throw error;
  }

  if (typeof callbackGateway.verifyWebhook === "function") {
    if (!callbackGateway.verifyWebhook(rawBody, signature)) {
      const error = new Error("Invalid UPI webhook signature.");
      error.status = 401;
      error.code = "UPI_WEBHOOK_SIGNATURE_INVALID";
      throw error;
    }
  }

  const payment = await Payment.findOne({ orderId, paymentMethod: "UPI" });
  if (!payment) {
    const error = new Error("Payment order not found.");
    error.status = 404;
    throw error;
  }

  const paymentGatewayId = normalizeUpiGatewayId(payment.provider || DEFAULT_UPI_GATEWAY_ID);
  if (paymentGatewayId !== callbackGateway.id) {
    const error = new Error("Payment gateway does not match callback route.");
    error.status = 400;
    error.code = "UPI_GATEWAY_MISMATCH";
    throw error;
  }

  if (payment.status === "PAID" || payment.status === "REFUNDED") return payment;

  if (callbackGateway.supportsStatusPolling) {
    return refreshUpiPayment(payment, { force: true });
  }

  return markUpiPayment(payment, payload);
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
    if (claimed.customerId) {
      const customer = await Customer.findOne({ customerId: claimed.customerId }).select("status").lean();
      if (String(customer?.status || "").toUpperCase() === "BLOCKED") {
        const blocked = new Error("Blocked customers cannot activate a trading account.");
        blocked.status = 403;
        blocked.code = "CUSTOMER_BLOCKED";
        throw blocked;
      }
    }
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

    const staged = account.platform === "acg-trader";
    if (account.provisioning?.status !== "ACTIVE" || !account.platformAccountId) {
      await provisionTradingAccount(account, {
        phase: 1,
        accountType: "CHALLENGE",
        activate: !staged,
      });
    }

    // Persist the accepted Phase 1 identity first. While staged, launch
    // selection still rejects the PAUSED platform record.
    account.status = "ACTIVE";
    account.enabled = !staged;
    await account.save();

    if (staged) {
      try {
        await activateTradingAccount(account, {
          reason: "ACG_FUNDED_PAID_CHALLENGE_COMMITTED",
        });
        const activated = await Account.findOneAndUpdate(
          {
            _id: account._id,
            status: "ACTIVE",
            customerAccessBlocked: { $ne: true },
          },
          {
            $set: {
              enabled: true,
              "platformAccounts.$[target].status": "ACTIVE",
            },
          },
          {
            new: true,
            arrayFilters: [{ "target.platformAccountId": account.platformAccountId }],
          },
        );
        if (!activated) {
          const superseded = new Error("Challenge activation was superseded by a newer lifecycle state.");
          superseded.code = "CHALLENGE_ACTIVATION_SUPERSEDED";
          throw superseded;
        }
        account = activated;
      } catch (error) {
        await stageTradingAccount(account, {
          reason: "ACG_FUNDED_PAID_CHALLENGE_ACTIVATION_FAILED",
        }).catch(() => {});
        await Account.updateOne(
          {
            _id: account._id,
            status: "ACTIVE",
          },
          { $set: { enabled: false } },
        ).catch(() => {});
        throw error;
      }
    }

    // Native credentials are additive; federated launch remains authoritative.
    await ensureTradingCredential(account, {
      email: claimed.email,
      queueEmail: true,
      platformAccountId: account.platformAccountId,
    }).catch(() => {});

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
    await recordAnalyticsEventOnce({
      event: "account_activated",
      sessionId: claimed.metadata?.analyticsSessionId || `payment:${claimed._id}`,
      email: claimed.email,
      accountId: account.accountId,
      paymentId: String(claimed._id),
      source: "server",
      attribution: claimed.metadata?.attribution || {},
      properties: {
        accountSize: account.accountSize,
        challengeType: account.challengeType,
        platform: account.platform,
      },
    }, { paymentId: String(claimed._id) }).catch(() => {});
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
  const expectedFiatCurrency = String(payment.currency || "USD").toLowerCase();
  if (payload.price_currency && String(payload.price_currency).toLowerCase() !== expectedFiatCurrency) throw new Error("Unexpected payment fiat currency.");
  if (Number.isFinite(receivedFiat) && Math.abs(receivedFiat - expectedFiat) > 0.01) throw new Error("Payment amount mismatch.");
  if (payload.pay_currency && String(payload.pay_currency).toLowerCase() !== expectedCrypto) throw new Error("Payment cryptocurrency mismatch.");

  payment.providerPaymentId = payload.payment_id ? String(payload.payment_id) : payment.providerPaymentId;
  payment.providerStatus = payload.payment_status;
  payment.paidAmount = Number(payload.actually_paid ?? payload.pay_amount ?? 0);
  payment.paidCurrency = payload.pay_currency;

  const requestedStatus = ({
    waiting: "WAITING",
    confirming: "CONFIRMING",
    confirmed: "PAID",
    finished: "PAID",
    failed: "FAILED",
    expired: "EXPIRED",
    partially_paid: "UNDERPAID",
    refunded: "REFUNDED",
  })[payload.payment_status];
  const previousStatus = payment.status;
  if (requestedStatus) payment.status = nextPaymentStatus(previousStatus, requestedStatus);
  const becamePaid = previousStatus !== "PAID" && payment.status === "PAID";
  if (payment.status === "PAID" && !payment.paidAt) payment.paidAt = new Date();
  await payment.save();

  if (["FAILED", "EXPIRED"].includes(payment.status)) {
    const event = payment.status === "EXPIRED" ? "payment_expired" : "payment_failed";
    await recordAnalyticsEventOnce({
      event,
      sessionId: payment.metadata?.analyticsSessionId || `payment:${payment._id}`,
      email: payment.email,
      paymentId: String(payment._id),
      source: "server",
      attribution: payment.metadata?.attribution || {},
      properties: {
        providerStatus: payment.providerStatus,
        amount: payment.amount,
        currency: payment.currency,
      },
    }, { paymentId: String(payment._id) }).catch(() => {});
  }

  if (becamePaid) {
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

export async function getPaymentStatus(id, statusToken) {
  let payment = await Payment.findById(id).select("orderId status amount currency paymentMethod provider providerAmount providerCurrency providerStatus paidAmount paidCurrency paidAt accountId activatedAt activation statusTokenHash providerLastCheckedAt");
  if (!payment || !statusToken || !payment.statusTokenHash || !safeStringEqual(hashToken(statusToken), payment.statusTokenHash)) {
    const error = new Error("Payment not found.");
    error.status = 404;
    throw error;
  }

  if (payment.paymentMethod === "UPI" && !["PAID", "REFUNDED"].includes(payment.status)) {
    try {
      await refreshUpiPayment(payment);
      payment = await Payment.findById(id).select("orderId status amount currency paymentMethod provider providerAmount providerCurrency providerStatus paidAmount paidCurrency paidAt accountId activatedAt activation statusTokenHash providerLastCheckedAt");
    } catch (error) {
      console.warn("[UPI] Status refresh failed:", error?.message || error);
    }
  }

  return {
    orderId: payment.orderId,
    status: payment.status,
    amount: payment.amount,
    currency: "USD",
    providerAmount: payment.providerAmount,
    providerCurrency: payment.providerCurrency,
    paidAmount: payment.paidAmount,
    paidCurrency: payment.paidCurrency,
    paidAt: payment.paidAt,
    accountId: payment.accountId,
    activatedAt: payment.activatedAt,
    activation: payment.activation,
  };
}
