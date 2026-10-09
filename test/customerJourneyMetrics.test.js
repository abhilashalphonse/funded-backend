import test from "node:test";
import assert from "node:assert/strict";
import Account from "../src/accounts/account.model.js";
import Payment from "../src/models/payment.model.js";
import { getCustomerCohortJourneys } from "../src/apis/services/customerJourneyMetrics.js";

test("customer cohort calculations allow purchases without a trial pass", async () => {
  const originalAccounts = Account.aggregate;
  const originalPayments = Payment.aggregate;
  try {
    Account.aggregate = () => ({
      allowDiskUse: async () => [{ customers: 8, traded: 5, passed: 1, purchased: 3 }],
    });
    Payment.aggregate = () => ({
      allowDiskUse: async () => [{ customers: 6, paid: 2, active: 1 }],
    });

    const journeys = await getCustomerCohortJourneys(new Date("2026-10-01T00:00:00.000Z"));
    assert.equal(journeys.trial.identity, "customer");
    assert.equal(journeys.trial.stages[3].count, 3);
    assert.equal(journeys.trial.stages[3].overallRate, 3 / 8);
    assert.equal(journeys.trial.stages[2].stepRate, null);
    assert.equal(journeys.paid.stages[1].overallRate, 2 / 6);
    assert.equal(journeys.paid.stages[2].stepRate, 1 / 2);
  } finally {
    Account.aggregate = originalAccounts;
    Payment.aggregate = originalPayments;
  }
});

test("trial cohorts join account trades and subsequent confirmed purchases", async () => {
  const originalAccounts = Account.aggregate;
  try {
    Account.aggregate = pipeline => {
      assert.equal(pipeline[0].$match.accountMode, "DEMO");
      assert.ok(pipeline.some(step => step.$lookup?.from === "analyticsevents"));
      assert.ok(pipeline.some(step => step.$lookup?.from === Payment.collection.name));
      return { allowDiskUse: async () => [] };
    };
    const { getCustomerJourneyMetrics } = await import("../src/apis/services/customerJourneyMetrics.js");
    const summary = await getCustomerJourneyMetrics(new Date("2026-10-01T00:00:00.000Z"));
    assert.equal(summary.customers, 0);
  } finally {
    Account.aggregate = originalAccounts;
  }
});
