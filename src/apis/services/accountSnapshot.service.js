import { randomUUID } from "node:crypto";
import Account from "../../accounts/account.model.js";
import boss from "../../config/boss.js";
import env from "../../config/env.js";
import redis from "../../config/redis.js";
import { processEvent } from "../../workers/state-engine/processEvent.js";

const SNAPSHOT_EVENT = "ACG_TRADER_ACCOUNT_SNAPSHOT";

const STORE_LATEST_SCRIPT = `
local key = KEYS[1]
local incoming_time = tonumber(ARGV[1]) or 0
local incoming_sequence = tonumber(ARGV[2]) or -1
local current_time = tonumber(redis.call('HGET', key, 'time')) or -1
local current_sequence = tonumber(redis.call('HGET', key, 'sequence')) or -1

if incoming_time < current_time then
  return 0
end

if incoming_time == current_time and incoming_sequence >= 0 and current_sequence >= 0 and incoming_sequence <= current_sequence then
  return 0
end

redis.call('HSET', key, 'time', ARGV[1], 'sequence', ARGV[2], 'event', ARGV[3])
redis.call('EXPIRE', key, tonumber(ARGV[4]))
return 1
`;

const ACQUIRE_PROJECTION_SCRIPT = `
local acquired = redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
if not acquired then
  return {0, ''}
end
local latest = redis.call('HGET', KEYS[2], 'event') or ''
return {1, latest}
`;

const RELEASE_PROJECTION_SCRIPT = `
local owned = 0
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  owned = 1
end
local latest = redis.call('HGET', KEYS[2], 'event') or ''
return {owned, latest}
`;

class SnapshotProjectionScheduler {
  constructor({ project, concurrency = 32, retryDelayMs = 5000, logger = console } = {}) {
    this.project = project;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.retryDelayMs = Math.max(1, Number(retryDelayMs) || 5000);
    this.logger = logger;
    this.pending = new Map();
    this.retryTimers = new Map();
    this.runningAccounts = new Set();
    this.active = 0;
    this.scheduled = false;
    this.processed = 0;
    this.failed = 0;
  }

  enqueue(event) {
    const accountId = String(event?.aggregateId || "").trim();
    if (!accountId) return;

    const retry = this.retryTimers.get(accountId);
    if (retry && compareSnapshotOrder(event, retry.event) >= 0) {
      clearTimeout(retry.timer);
      this.retryTimers.delete(accountId);
    }

    const existing = this.pending.get(accountId);
    if (!existing || compareSnapshotOrder(event, existing) >= 0) {
      this.pending.set(accountId, event);
    }
    this.#scheduleDrain();
  }

  health() {
    return {
      concurrency: this.concurrency,
      pending: this.pending.size,
      active: this.active,
      processed: this.processed,
      failed: this.failed,
      retrying: this.retryTimers.size,
    };
  }

  #scheduleDrain() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.#drain();
    });
  }

  #next() {
    for (const [accountId, event] of this.pending) {
      if (this.runningAccounts.has(accountId)) continue;
      this.pending.delete(accountId);
      return [accountId, event];
    }
    return null;
  }

  #drain() {
    while (this.active < this.concurrency) {
      const next = this.#next();
      if (!next) break;
      const [accountId, event] = next;
      this.active += 1;
      this.runningAccounts.add(accountId);

      Promise.resolve(this.project(event))
        .then(() => {
          this.processed += 1;
          const retry = this.retryTimers.get(accountId);
          if (retry && compareSnapshotOrder(event, retry.event) >= 0) {
            clearTimeout(retry.timer);
            this.retryTimers.delete(accountId);
          }
        })
        .catch(error => {
          this.failed += 1;
          this.logger?.error?.("[snapshot-projector] projection failed; retry scheduled", {
            accountId,
            message: error?.message,
            code: error?.code,
          });
          this.#scheduleRetry(accountId, event);
        })
        .finally(() => {
          this.active -= 1;
          this.runningAccounts.delete(accountId);
          if (this.pending.size) this.#scheduleDrain();
        });
    }
  }

  #scheduleRetry(accountId, event) {
    const existing = this.retryTimers.get(accountId);
    if (existing && compareSnapshotOrder(existing.event, event) >= 0) return;
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.retryTimers.delete(accountId);
      this.enqueue(event);
    }, this.retryDelayMs);
    timer.unref?.();
    this.retryTimers.set(accountId, { event, timer });
  }
}

class AccountSnapshotService {
  constructor({
    redisClient = redis,
    accountModel = Account,
    bossInstance = boss,
    cacheTtlSeconds = env.ACG_SNAPSHOT_CACHE_TTL_SECONDS,
    bindingTtlSeconds = env.ACG_SNAPSHOT_BINDING_TTL_SECONDS,
    projectionConcurrency = env.ACG_SNAPSHOT_PROJECTION_CONCURRENCY,
    projectionLockMs = env.ACG_SNAPSHOT_PROJECTION_LOCK_MS,
    projectionRetryMs = env.ACG_SNAPSHOT_PROJECTION_RETRY_MS,
    logger = console,
  } = {}) {
    this.redis = redisClient;
    this.accountModel = accountModel;
    this.boss = bossInstance;
    this.cacheTtlSeconds = cacheTtlSeconds;
    this.bindingTtlSeconds = bindingTtlSeconds;
    this.projectionLockMs = projectionLockMs;
    this.logger = logger;
    this.accepted = 0;
    this.stale = 0;
    this.redisFallbacks = 0;
    this.bindingCache = new Map();
    this.bindingCacheHits = 0;
    this.scheduler = new SnapshotProjectionScheduler({
      concurrency: projectionConcurrency,
      retryDelayMs: projectionRetryMs,
      logger,
      project: event => this.#projectLatest(event),
    });
  }

  health() {
    return {
      redis: this.redis.health?.() || { configured: Boolean(this.redis?.configured) },
      accepted: this.accepted,
      stale: this.stale,
      redisFallbacks: this.redisFallbacks,
      bindingCacheEntries: this.bindingCache.size,
      bindingCacheHits: this.bindingCacheHits,
      projector: this.scheduler.health(),
    };
  }

  async authorize(accountId, platformAccountId) {
    const aggregateId = String(accountId || "").trim();
    const platformId = String(platformAccountId || "").trim();
    if (!aggregateId || !platformId) return { exists: false, matches: false, cached: false };

    const localKey = bindingKey(aggregateId, platformId);
    const localExpiry = this.bindingCache.get(localKey);
    if (localExpiry && localExpiry > Date.now()) {
      this.bindingCacheHits += 1;
      return { exists: true, matches: true, cached: true };
    }
    if (localExpiry) this.bindingCache.delete(localKey);

    if (this.redis.configured) {
      try {
        const cached = await this.redis.get(localKey);
        if (cached === "1" || cached === 1) {
          this.bindingCache.set(localKey, Date.now() + this.bindingTtlSeconds * 1000);
          return { exists: true, matches: true, cached: true };
        }
      } catch (error) {
        this.#redisWarning("binding lookup", error);
      }
    }

    const account = await this.accountModel.findOne({ accountId: aggregateId })
      .select("platformAccountId platformAccounts")
      .lean();
    if (!account) return { exists: false, matches: false, cached: false };

    const matches = platformAccountMatches(account, platformId);
    if (matches) {
      this.bindingCache.set(localKey, Date.now() + this.bindingTtlSeconds * 1000);
      if (this.redis.configured) {
        try {
          await this.redis.set(localKey, "1", "EX", this.bindingTtlSeconds);
        } catch (error) {
          this.#redisWarning("binding cache", error);
        }
      }
    }

    return { exists: true, matches, cached: false };
  }

  async receive(event) {
    if (event?.eventType !== SNAPSHOT_EVENT) {
      throw new Error("AccountSnapshotService only accepts ACG Trader account snapshots");
    }

    let accepted = true;
    let redisStored = false;
    let degraded = false;

    if (this.redis.configured) {
      try {
        accepted = await this.#storeLatest(event);
        redisStored = accepted;
      } catch (error) {
        degraded = true;
        this.redisFallbacks += 1;
        this.#redisWarning("snapshot store", error);
      }
    }

    if (!accepted) {
      this.stale += 1;
      return { accepted: false, stale: true, redisStored: false, degraded };
    }

    this.accepted += 1;
    this.scheduler.enqueue(event);
    return { accepted: true, stale: false, redisStored, degraded };
  }

  async getLatest(accountId) {
    if (!this.redis.configured) return null;
    const raw = await this.redis.hget(snapshotKey(accountId), "event");
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch { return null; }
  }

  async #storeLatest(event) {
    const time = snapshotTimeMs(event);
    const sequence = snapshotSequence(event);
    const result = await this.redis.eval(
      STORE_LATEST_SCRIPT,
      [snapshotKey(event.aggregateId)],
      [time, sequence ?? -1, JSON.stringify(event), this.cacheTtlSeconds],
    );
    return Number(result) === 1;
  }

  async #projectLatest(event) {
    const accountId = String(event.aggregateId);
    let lockToken = null;
    let projected = event;

    if (this.redis.configured) {
      lockToken = randomUUID();
      try {
        const result = await this.redis.eval(
          ACQUIRE_PROJECTION_SCRIPT,
          [projectionLockKey(accountId), snapshotKey(accountId)],
          [lockToken, this.projectionLockMs],
        );
        if (!Array.isArray(result) || Number(result[0]) !== 1) return;

        const latest = parseSnapshot(result[1]);
        if (latest && compareSnapshotOrder(latest, projected) >= 0) projected = latest;
      } catch (error) {
        lockToken = null;
        this.#redisWarning("projection lock", error);
      }
    }

    try {
      await processEvent(projected, this.boss, { accountModel: this.accountModel });
    } finally {
      if (lockToken) {
        try {
          const result = await this.redis.eval(
            RELEASE_PROJECTION_SCRIPT,
            [projectionLockKey(accountId), snapshotKey(accountId)],
            [lockToken],
          );
          const latest = Array.isArray(result) ? parseSnapshot(result[1]) : null;
          if (latest && compareSnapshotOrder(latest, projected) > 0) this.scheduler.enqueue(latest);
        } catch (error) {
          this.#redisWarning("projection unlock", error);
        }
      }
    }
  }

  #redisWarning(operation, error) {
    this.logger?.warn?.(`[snapshot-redis] ${operation} failed; using safe fallback`, {
      message: error?.message,
      code: error?.code,
    });
  }
}

function parseSnapshot(raw) {
  if (!raw) return null;
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { return null; }
}

function snapshotKey(accountId) {
  return `acg:funded:account:${String(accountId)}:snapshot`;
}

function bindingKey(accountId, platformAccountId) {
  return `acg:funded:binding:${String(accountId)}:${String(platformAccountId)}`;
}

function projectionLockKey(accountId) {
  return `acg:funded:account:${String(accountId)}:snapshot-projection-lock`;
}

function snapshotTimeMs(event) {
  const valuedAt = Number(event?.payload?.valuedAtMs);
  if (Number.isFinite(valuedAt) && valuedAt > 0) return Math.trunc(valuedAt);
  const parsed = new Date(event?.timestamp || event?.occurredAt || event?.receivedAt || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function snapshotSequence(event) {
  const value = Number(event?.payload?.valuationSequence);
  return Number.isFinite(value) ? value : null;
}

function compareSnapshotOrder(left, right) {
  const leftTime = snapshotTimeMs(left);
  const rightTime = snapshotTimeMs(right);
  if (leftTime !== rightTime) return leftTime > rightTime ? 1 : -1;

  const leftSequence = snapshotSequence(left);
  const rightSequence = snapshotSequence(right);
  if (leftSequence === null || rightSequence === null || leftSequence === rightSequence) return 0;
  return leftSequence > rightSequence ? 1 : -1;
}

function platformAccountMatches(account, platformAccountId) {
  const target = String(platformAccountId);
  if (String(account?.platformAccountId || "") === target) return true;
  return Array.isArray(account?.platformAccounts)
    && account.platformAccounts.some(item => String(item?.platformAccountId || "") === target);
}

const accountSnapshotService = new AccountSnapshotService();

export {
  AccountSnapshotService,
  SnapshotProjectionScheduler,
  compareSnapshotOrder,
  platformAccountMatches,
  snapshotKey,
};
export default accountSnapshotService;
