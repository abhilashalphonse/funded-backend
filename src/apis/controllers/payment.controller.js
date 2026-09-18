import { createCryptoPayment, getPaymentStatus, processIpn } from "../services/payment.service.js";

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
