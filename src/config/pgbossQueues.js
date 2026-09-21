const HOUR = 60 * 60;
const DAY = 24 * HOUR;

export const PG_BOSS_QUEUE_POLICIES = Object.freeze({
  "incoming-events": Object.freeze({
    retentionSeconds: DAY,
    deleteAfterSeconds: 6 * HOUR,
  }),
  "state-events": Object.freeze({
    retentionSeconds: DAY,
    deleteAfterSeconds: 6 * HOUR,
  }),
  "account-commands": Object.freeze({
    retentionSeconds: 7 * DAY,
    deleteAfterSeconds: 3 * DAY,
  }),
  "payment-activation": Object.freeze({
    retentionSeconds: 14 * DAY,
    deleteAfterSeconds: 7 * DAY,
  }),
  "trading-credential-email": Object.freeze({
    retentionSeconds: 7 * DAY,
    deleteAfterSeconds: 3 * DAY,
  }),
});

export const PG_BOSS_QUEUE_NAMES = Object.freeze(Object.keys(PG_BOSS_QUEUE_POLICIES));
