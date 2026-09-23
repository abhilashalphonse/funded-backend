import { createCryptoPayment, createUpiPayment, getPaymentStatus, getUpiQuote, processIpn, processUpiCallback } from "../services/payment.service.js";

export async function createCrypto(req, res, next) {
  try {
    const payload = {
      ...(req.body ?? {}),
      customer: req.customer || null,
      email: req.customer?.email || req.body?.email,
      analyticsSessionId: req.get("x-acg-session-id") || req.body?.analyticsSessionId,
      attribution: req.body?.attribution || {},
    };
    delete payload.ownerExternalRef;
    delete payload.customerId;
    res.status(201).json({ success: true, data: await createCryptoPayment(payload) });
  } catch (error) { next(error); }
}

export async function ipn(req, res, next) {
  try {
    const payment = await processIpn(req.body ?? {}, req.get("x-nowpayments-sig"));
    res.json({ success: true, data: { paymentId: payment._id, status: payment.status } });
  } catch (error) { next(error); }
}

export async function status(req, res, next) {
  try { res.json({ success: true, data: await getPaymentStatus(req.params.paymentId, req.query?.token) }); }
  catch (error) { next(error); }
}


export async function createUpi(req, res, next) {
  try {
    const payload = {
      ...(req.body ?? {}),
      customer: req.customer || null,
      email: req.customer?.email || req.body?.email,
      analyticsSessionId: req.get("x-acg-session-id") || req.body?.analyticsSessionId,
      attribution: req.body?.attribution || {},
    };
    delete payload.ownerExternalRef;
    delete payload.customerId;
    res.status(201).json({ success: true, data: await createUpiPayment(payload) });
  } catch (error) { next(error); }
}

export async function upiQuote(req, res, next) {
  try {
    res.json({ success: true, data: await getUpiQuote(req.body || {}) });
  } catch (error) { next(error); }
}

export async function upiCallback(req, res, next) {
  try {
    await processUpiCallback(
      { ...(req.query || {}), ...(req.body || {}) },
      req.params?.gatewayId || "rupex",
      {
        rawBody: req.rawBody || null,
        signature: req.get("x-signature"),
      },
    );
    return res.status(200).json({ success: true });
  } catch (error) { next(error); }
}
