import Customer from "../../customers/customer.model.js";

const TAGS = ["utmSource", "utmCampaign", "utmMedium", "creatorId", "creativeId", "affiliate", "referral"];
const hasTags = value => value && TAGS.some(tag => Boolean(value[tag]));

export async function paymentAttribution(customerId, submitted = {}) {
  const incoming = submitted && typeof submitted === "object" && !Array.isArray(submitted) ? submitted : {};
  const customer = await Customer.findOne({ customerId })
    .select("marketingAttribution").lean();
  const saved = customer?.marketingAttribution || {};
  const submittedFirst = hasTags(incoming.firstTouch) ? incoming.firstTouch : (hasTags(incoming) ? incoming : {});
  const submittedLast = hasTags(incoming.lastTouch) ? incoming.lastTouch : submittedFirst;
  return {
    anonymousId: saved.anonymousId || incoming.anonymousId,
    firstTouch: hasTags(saved.firstTouch) ? saved.firstTouch : submittedFirst,
    lastTouch: hasTags(submittedLast) ? submittedLast : (saved.lastTouch || saved.firstTouch || {}),
  };
}
