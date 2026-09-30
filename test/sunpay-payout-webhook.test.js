import test from "node:test";
import assert from "node:assert/strict";

import ProviderWebhookEvent from "../src/models/providerWebhookEvent.model.js";
import {
  processSunpayPayoutWebhook,
  registerSunpayPayoutWebhook,
  sunpayPayoutWebhookIdentity,
} from "../src/apis/services/payoutProviders/sunpayPayoutWebhook.service.js";

function matchesCondition(record, condition = {}) {
  if (condition.status !== undefined) {
    if (typeof condition.status === "string" && record.status !== condition.status) return false;
    if (condition.status?.$in && !condition.status.$in.includes(record.status)) return false;
  }
  if (condition.processingStartedAt?.$lte) {
    if (!record.processingStartedAt) return false;
    if (new Date(record.processingStartedAt) > new Date(condition.processingStartedAt.$lte)) return false;
  }
  return true;
}

function memoryEventModel() {
  const records = new Map();

  return {
    records,
    async create(record) {
      if (records.has(record.eventKey)) {
        const error = new Error("duplicate webhook event");
        error.code = 11000;
        throw error;
      }
      const created = { ...record };
      records.set(record.eventKey, created);
      return { ...created };
    },
    async findOne(query) {
      const record = records.get(query.eventKey);
      return record ? { ...record } : null;
    },
    async findOneAndUpdate(filter, update) {
      const current = records.get(filter.eventKey);
      if (!current) return null;

      if (filter.$or && !filter.$or.some(condition => matchesCondition(current, condition))) return null;
      if (!filter.$or && !matchesCondition(current, filter)) return null;

      const next = {
        ...current,
        ...(update?.$set || {}),
      };
      for (const [key, value] of Object.entries(update?.$inc || {})) {
        next[key] = Number(next[key] || 0) + Number(value);
      }
      records.set(filter.eventKey, next);
      return { ...next };
    },
  };
}

const event = {
  event: "payout.updated",
  id: "pyt_01H",
  payout_id: "PAYOUT-001",
  status: "success",
  amount: 1000,
  fee: 30,
  net_amount: 970,
};

test("Sunpay payout webhook identity is stable across provider retries", () => {
  const identity = sunpayPayoutWebhookIdentity(event);

  assert.equal(identity.eventKey, "sunpay:payout.updated:pyt_01H");
  assert.equal(identity.providerEventId, "pyt_01H");
  assert.equal(identity.businessId, "PAYOUT-001");
  assert.equal(identity.providerReportedStatus, "success");
});

test("Sunpay payout webhook rejects missing provider event id", () => {
  assert.throws(
    () => sunpayPayoutWebhookIdentity({ event: "payout.updated", payout_id: "PAYOUT-001" }),
    error => error?.code === "SUNPAY_PAYOUT_WEBHOOK_EVENT_ID_REQUIRED",
  );
});

test("duplicate Sunpay webhook deliveries persist once and increment delivery count", async () => {
  const eventModel = memoryEventModel();
  const rawBody = Buffer.from(JSON.stringify(event));
  const firstAt = new Date("2026-09-30T10:00:00.000Z");
  const secondAt = new Date("2026-09-30T10:01:00.000Z");

  const first = await registerSunpayPayoutWebhook(event, {
    rawBody,
    eventModel,
    now: () => firstAt,
  });
  const second = await registerSunpayPayoutWebhook(event, {
    rawBody,
    eventModel,
    now: () => secondAt,
  });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(eventModel.records.size, 1);

  const stored = eventModel.records.get(first.eventKey);
  assert.equal(stored.deliveries, 2);
  assert.equal(stored.status, "RECEIVED");
  assert.equal(stored.receivedAt.toISOString(), firstAt.toISOString());
  assert.equal(stored.lastReceivedAt.toISOString(), secondAt.toISOString());
  assert.match(stored.payloadHash, /^[0-9a-f]{64}$/);
});

test("persisted webhook processing reconciles once and marks the event processed", async () => {
  const eventModel = memoryEventModel();
  const registration = await registerSunpayPayoutWebhook(event, { eventModel });
  let noteCalls = 0;
  let reconcileCalls = 0;

  const first = await processSunpayPayoutWebhook(registration.eventKey, {
    eventModel,
    noteWebhook: async payoutId => {
      noteCalls += 1;
      assert.equal(payoutId, "PAYOUT-001");
    },
    reconcile: async payoutId => {
      reconcileCalls += 1;
      assert.equal(payoutId, "PAYOUT-001");
      return { payoutId, status: "PAID" };
    },
  });

  const duplicate = await processSunpayPayoutWebhook(registration.eventKey, {
    eventModel,
    noteWebhook: async () => { noteCalls += 1; },
    reconcile: async () => { reconcileCalls += 1; },
  });

  assert.equal(first.status, "PROCESSED");
  assert.equal(duplicate.status, "PROCESSED");
  assert.equal(noteCalls, 1);
  assert.equal(reconcileCalls, 1);
  assert.equal(eventModel.records.get(registration.eventKey).attempts, 1);
});

test("failed webhook processing is durable and can be retried safely", async () => {
  const eventModel = memoryEventModel();
  const registration = await registerSunpayPayoutWebhook(event, { eventModel });
  let reconcileCalls = 0;

  await assert.rejects(
    () => processSunpayPayoutWebhook(registration.eventKey, {
      eventModel,
      noteWebhook: async () => {},
      reconcile: async () => {
        reconcileCalls += 1;
        const error = new Error("temporary provider timeout");
        error.code = "SUNPAY_TIMEOUT";
        throw error;
      },
    }),
    error => error?.code === "SUNPAY_TIMEOUT",
  );

  let stored = eventModel.records.get(registration.eventKey);
  assert.equal(stored.status, "FAILED");
  assert.equal(stored.attempts, 1);
  assert.equal(stored.lastError.code, "SUNPAY_TIMEOUT");

  const retried = await processSunpayPayoutWebhook(registration.eventKey, {
    eventModel,
    noteWebhook: async () => {},
    reconcile: async () => {
      reconcileCalls += 1;
      return { status: "PROCESSING" };
    },
  });

  stored = eventModel.records.get(registration.eventKey);
  assert.equal(retried.status, "PROCESSED");
  assert.equal(stored.attempts, 2);
  assert.equal(reconcileCalls, 2);
});

test("a later status for the same Sunpay payout event id is requeued for authoritative reconciliation", async () => {
  const eventModel = memoryEventModel();
  const pending = { ...event, status: "processing" };
  const registration = await registerSunpayPayoutWebhook(pending, {
    eventModel,
    now: () => new Date("2026-09-30T10:00:00.000Z"),
  });

  await processSunpayPayoutWebhook(registration.eventKey, {
    eventModel,
    now: () => new Date("2026-09-30T10:00:10.000Z"),
    noteWebhook: async () => {},
    reconcile: async () => ({ status: "PROCESSING" }),
  });
  assert.equal(eventModel.records.get(registration.eventKey).status, "PROCESSED");

  const changed = await registerSunpayPayoutWebhook(
    { ...event, status: "success" },
    {
      eventModel,
      now: () => new Date("2026-09-30T10:01:00.000Z"),
    },
  );

  assert.equal(changed.duplicate, true);
  assert.equal(changed.requeued, true);
  assert.equal(eventModel.records.get(registration.eventKey).status, "RECEIVED");

  let reconciles = 0;
  await processSunpayPayoutWebhook(registration.eventKey, {
    eventModel,
    now: () => new Date("2026-09-30T10:01:01.000Z"),
    noteWebhook: async () => {},
    reconcile: async () => {
      reconciles += 1;
      return { status: "PAID" };
    },
  });

  assert.equal(reconciles, 1);
  assert.equal(eventModel.records.get(registration.eventKey).status, "PROCESSED");
  assert.equal(eventModel.records.get(registration.eventKey).attempts, 2);
});

test("stale PROCESSING webhook work can be reclaimed after the processing lease", async () => {
  const eventModel = memoryEventModel();
  const registration = await registerSunpayPayoutWebhook(event, { eventModel });
  const stored = eventModel.records.get(registration.eventKey);
  eventModel.records.set(registration.eventKey, {
    ...stored,
    status: "PROCESSING",
    attempts: 1,
    processingStartedAt: new Date("2026-09-30T10:00:00.000Z"),
  });

  let reconciles = 0;
  const result = await processSunpayPayoutWebhook(registration.eventKey, {
    eventModel,
    now: () => new Date("2026-09-30T10:03:00.000Z"),
    noteWebhook: async () => {},
    reconcile: async () => {
      reconciles += 1;
      return { status: "PROCESSING" };
    },
  });

  assert.equal(result.status, "PROCESSED");
  assert.equal(reconciles, 1);
  assert.equal(eventModel.records.get(registration.eventKey).attempts, 2);
});

test("provider webhook ledger enforces durable event uniqueness", () => {
  const indexes = ProviderWebhookEvent.schema.indexes();
  const uniqueEvent = indexes.find(([, options]) => options?.name === "unique_provider_webhook_event");

  assert.deepEqual(uniqueEvent?.[0], {
    provider: 1,
    eventType: 1,
    providerEventId: 1,
  });
  assert.equal(uniqueEvent?.[1]?.unique, true);
});
