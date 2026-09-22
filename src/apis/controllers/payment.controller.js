import { createCryptoPayment, createUpiPayment, getPaymentStatus, processIpn, processRupayexCallback } from "../services/payment.service.js";

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
  try { res.json({ success: true, data: await getPaymentStatus(req.params.paymentId) }); }
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

export async function rupayexCallback(req, res, next) {
  try {
    const payment = await processRupayexCallback({ ...(req.query || {}), ...(req.body || {}) });
    const frontend = String(process.env.FRONTEND_URL || "").replace(/\/$/, "");
    const location = `${frontend}/?payment=${encodeURIComponent(payment._id)}&status=success`;
    if (frontend) return res.redirect(303, location);
    return res.json({ success: true, data: { paymentId: payment._id, status: payment.status } });
  } catch (error) { next(error); }
}
