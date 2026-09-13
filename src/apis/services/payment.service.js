import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import Payment from "../../models/payment.model.js";
import { calculatePrice } from "../../pricing/pricingEngine.js";

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

export async function createCryptoPayment({ email, challengeDefinition, commercialConfig, paymentMethod }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) throw new Error("A valid email is required.");
  if (!allowedMethods[paymentMethod]) throw new Error("Unsupported crypto payment method.");

  const pricing = calculatePrice(challengeDefinition, commercialConfig);
  const orderId = `ACG-${randomUUID()}`;
  const payment = await Payment.create({ orderId, email: normalizedEmail, challengeDefinition, commercialConfig, amount: pricing.finalPrice, currency: "EUR", paymentMethod, status: "CREATED" });

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
    payment.metadata = { pricing };
    await payment.save();
    return { paymentId: payment._id, orderId, amount: pricing.finalPrice, currency: "EUR", checkoutUrl: payment.checkoutUrl };
  } catch (error) {
    payment.status = "FAILED";
    payment.providerStatus = error.message;
    await payment.save();
    throw error;
  }
}

function verifyIpnSignature(payload, signature) {
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!secret || !signature) return false;
  const sorted = Object.keys(payload).sort().reduce((acc, key) => { acc[key] = payload[key]; return acc; }, {});
  const digest = crypto.createHmac("sha512", secret).update(JSON.stringify(sorted)).digest("hex");
  if (digest.length !== String(signature).length) return false;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(signature)));
}

export async function processIpn(payload, signature) {
  if (!verifyIpnSignature(payload, signature)) {
    const error = new Error("Invalid NOWPayments IPN signature.");
    error.status = 401;
    throw error;
  }
  const payment = await Payment.findOne({ orderId: payload.order_id });
  if (!payment) { const error = new Error("Payment order not found."); error.status = 404; throw error; }

  payment.providerPaymentId = payload.payment_id ? String(payload.payment_id) : payment.providerPaymentId;
  payment.providerStatus = payload.payment_status;
  payment.paidAmount = Number(payload.actually_paid ?? payload.pay_amount ?? 0);
  payment.paidCurrency = payload.pay_currency;
  payment.status = ({ waiting: "WAITING", confirming: "CONFIRMING", confirmed: "PAID", finished: "PAID", failed: "FAILED", expired: "EXPIRED", partially_paid: "UNDERPAID" })[payload.payment_status] || payment.status;
  if (payment.status === "PAID" && !payment.paidAt) payment.paidAt = new Date();
  await payment.save();
  return payment;
}

export async function getPaymentStatus(id) {
  const payment = await Payment.findById(id).select("orderId status amount currency checkoutUrl providerStatus paidAmount paidCurrency paidAt");
  if (!payment) { const error = new Error("Payment not found."); error.status = 404; throw error; }
  return payment;
}
