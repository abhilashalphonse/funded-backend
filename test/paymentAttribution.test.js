import test from "node:test";
import assert from "node:assert/strict";
import Customer from "../src/customers/customer.model.js";
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
