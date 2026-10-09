import Customer from "../../customers/customer.model.js";
import Payment from "../../models/payment.model.js";

const TAGS = ["utmSource", "utmCampaign", "utmMedium", "creatorId", "creativeId", "affiliate", "referral"];
const hasTags = value => value && TAGS.some(tag => Boolean(value[tag]));

export async function paymentAttribution(customerId, submitted = {}) {
  const incoming = submitted && typeof submitted === "object" && !Array.isArray(submitted) ? submitted : {};
  const customer = await Customer.findOne({ customerId })
    .select("marketingAttribution").lean();
  const saved = customer?.marketingAttribution || {};
  // Guest buyers may not have signed in before their first verified payment.
  // Reuse the earliest confirmed payment attribution if the customer profile
  // does not yet have a first touch.
  let earlierTouch = null;
  if (!hasTags(saved.firstTouch)) {
    const earlierPayment = await Payment.findOne({ customerId, status: "PAID" })
      .sort({ paidAt: 1 }).select("metadata.attribution").lean();
    earlierTouch = earlierPayment?.metadata?.attribution?.firstTouch
      || earlierPayment?.metadata?.attribution || null;
  }
  const submittedFirst = hasTags(incoming.firstTouch) ? incoming.firstTouch : (hasTags(incoming) ? incoming : {});
  const submittedLast = hasTags(incoming.lastTouch) ? incoming.lastTouch : submittedFirst;
  return {
    anonymousId: saved.anonymousId || incoming.anonymousId,
    firstTouch: hasTags(saved.firstTouch) ? saved.firstTouch : (hasTags(earlierTouch) ? earlierTouch : submittedFirst),
    lastTouch: hasTags(submittedLast) ? submittedLast : (saved.lastTouch || saved.firstTouch || {}),
  };
}
