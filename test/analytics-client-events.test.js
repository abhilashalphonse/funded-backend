import test from "node:test";
import assert from "node:assert/strict";
import { recordAnalyticsEvent } from "../src/apis/services/analytics.service.js";

test("client analytics are limited to observed engagement events", async () => {
  for (const event of ["payment_completed", "trial_passed", "account_activated"]) {
    await assert.rejects(
      recordAnalyticsEvent({ event, sessionId: "test-session", source: "client" }),
      error => error.status === 400,
    );
  }
});
