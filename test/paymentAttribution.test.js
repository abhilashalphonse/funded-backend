import test from "node:test";
import assert from "node:assert/strict";
import Customer from "../src/customers/customer.model.js";
import Payment from "../src/models/payment.model.js";
import { paymentAttribution } from "../src/apis/services/paymentAttribution.js";

test("confirmed customer acquisition is retained across checkout devices", async () => {
  const originalFind = Customer.findOne;
  try {
    Customer.findOne = () => ({
      select: () => ({
        lean: async () => ({ marketingAttribution: {
          anonymousId: "original-visitor",
          firstTouch: { utmSource: "instagram", creatorId: "original-creator" },
        } }),
      }),
    });
    const result = await paymentAttribution("customer-id", {
      anonymousId: "new-browser",
      firstTouch: { utmSource: "direct", creatorId: "new-creator" },
    });
    assert.equal(result.firstTouch.creatorId, "original-creator");
    assert.equal(result.anonymousId, "original-visitor");
    assert.equal(result.lastTouch.creatorId, "new-creator");
  } finally {
    Customer.findOne = originalFind;
  }
});

test("guest checkout reuses attribution from an earlier paid order", async () => {
  const originalCustomer = Customer.findOne;
  const originalPayment = Payment.findOne;
  try {
    Customer.findOne = () => ({
      select: () => ({ lean: async () => ({ marketingAttribution: {} }) }),
    });
    Payment.findOne = () => ({
      sort: () => ({
        select: () => ({
          lean: async () => ({ metadata: { attribution: {
            firstTouch: { utmSource: "instagram", creatorId: "earlier-creator" },
          } } }),
        }),
      }),
    });
    const result = await paymentAttribution("guest-customer", {
      firstTouch: { utmSource: "direct" },
    });
    assert.equal(result.firstTouch.creatorId, "earlier-creator");
  } finally {
    Customer.findOne = originalCustomer;
    Payment.findOne = originalPayment;
  }
});
