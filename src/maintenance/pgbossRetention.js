import pool from "../config/postgres.js";
import env from "../config/env.js";
import { PG_BOSS_QUEUE_POLICIES } from "../config/pgbossQueues.js";

const TERMINAL_STATES = Object.freeze(["completed", "cancelled", "failed"]);
const QUEUE_STATS_RETENTION_DAYS = 1;
const WARNING_RETENTION_DAYS = 7;

export class PgBossRetention {
  constructor({
    db = pool,
    logger = console,
    intervalMs = env.PG_BOSS_RETENTION_INTERVAL_MS,
    initialDelayMs = env.PG_BOSS_RETENTION_INITIAL_DELAY_MS,
    batchSize = env.PG_BOSS_RETENTION_BATCH_SIZE,
    maxBatchesPerRun = env.PG_BOSS_RETENTION_MAX_BATCHES,
    lockTimeoutMs = env.PG_BOSS_RETENTION_LOCK_TIMEOUT_MS,
    statementTimeoutMs = env.PG_BOSS_RETENTION_STATEMENT_TIMEOUT_MS,
  } = {}) {
    this.db = db;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.initialDelayMs = initialDelayMs;
    this.batchSize = batchSize;
    this.maxBatchesPerRun = maxBatchesPerRun;
    this.lockTimeoutMs = lockTimeoutMs;
    this.statementTimeoutMs = statementTimeoutMs;
    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastResult = null;
  }

  health() {
    return {
      enabled: env.PG_BOSS_RETENTION_ENABLED,
      running: this.running,
      intervalMs: this.intervalMs,
      batchSize: this.batchSize,
      maxBatchesPerRun: this.maxBatchesPerRun,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
    };
  }

  start() {
    if (!env.PG_BOSS_RETENTION_ENABLED || this.timer) return;
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => this.#scheduleNext());
    }, this.initialDelayMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  #scheduleNext() {
    if (!env.PG_BOSS_RETENTION_ENABLED) return;
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => this.#scheduleNext());
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async audit() {
    const [sizeResult, stateResult, queueResult] = await Promise.all([
      this.db.query(`
        SELECT
          relname AS relation,
          pg_total_relation_size(c.oid)::bigint AS bytes
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pgboss'
          AND c.relkind IN ('r', 'p')
        ORDER BY bytes DESC
      `),
      this.db.query(`
        SELECT name, state::text AS state, COUNT(*)::bigint AS count
        FROM pgboss.job
        GROUP BY name, state
        ORDER BY name, state
      `),
      this.db.query(`
        SELECT
          name,
          retention_seconds AS "retentionSeconds",
          deletion_seconds AS "deleteAfterSeconds",
          table_name AS "tableName"
        FROM pgboss.queue
        ORDER BY name
      `),
    ]);

    const candidates = {};
    for (const [queueName, policy] of Object.entries(PG_BOSS_QUEUE_POLICIES)) {
      const result = await this.db.query(
        `
          SELECT COUNT(*)::bigint AS count
          FROM pgboss.job
          WHERE name = $1
            AND state::text = ANY($2::text[])
            AND completed_on IS NOT NULL
            AND completed_on < now() - ($3::int * interval '1 second')
        `,
        [queueName, TERMINAL_STATES, policy.deleteAfterSeconds],
      );
      candidates[queueName] = Number(result.rows[0]?.count || 0);
    }

    return {
      relations: sizeResult.rows.map(row => ({
        relation: row.relation,
        bytes: Number(row.bytes || 0),
      })),
      states: stateResult.rows.map(row => ({
        name: row.name,
        state: row.state,
        count: Number(row.count || 0),
      })),
      queues: queueResult.rows,
      cleanupCandidates: candidates,
    };
  }

  async runOnce({ maxBatches = this.maxBatchesPerRun } = {}) {
    if (this.running) return { skipped: true, reason: "already-running" };
    this.running = true;
    const startedAt = new Date().toISOString();
    const deletedByQueue = {};

    try {
      for (const [queueName, policy] of Object.entries(PG_BOSS_QUEUE_POLICIES)) {
        let deleted = 0;
        for (let batch = 0; batch < maxBatches; batch += 1) {
          const count = await this.#deleteTerminalBatch(queueName, policy.deleteAfterSeconds);
          deleted += count;
          if (count < this.batchSize) break;
        }
        deletedByQueue[queueName] = deleted;
      }

      const queueStatsDeleted = await this.#deleteAuxiliaryRows(
        "queue_stats",
        "captured_on",
        QUEUE_STATS_RETENTION_DAYS,
      );
      const warningsDeleted = await this.#deleteAuxiliaryRows(
        "warning",
        "created_on",
        WARNING_RETENTION_DAYS,
      );

      this.lastRunAt = new Date().toISOString();
      this.lastResult = {
        startedAt,
        completedAt: this.lastRunAt,
        deletedByQueue,
        queueStatsDeleted,
        warningsDeleted,
      };

      const totalDeleted = Object.values(deletedByQueue).reduce((sum, value) => sum + value, 0);
      if (totalDeleted || queueStatsDeleted || warningsDeleted) {
        this.logger.info?.("[pg-boss-retention] cleanup complete", this.lastResult);
      }
      return this.lastResult;
    } catch (error) {
      if (["55P03", "57014"].includes(error?.code)) {
        this.logger.warn?.("[pg-boss-retention] cleanup deferred due to database contention", {
          code: error.code,
          message: error.message,
        });
        return { deferred: true, code: error.code };
      }
      throw error;
    } finally {
      this.running = false;
    }
  }

  async #deleteTerminalBatch(queueName, deleteAfterSeconds) {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'`);
      await client.query(`SET LOCAL statement_timeout = '${this.statementTimeoutMs}ms'`);
      const result = await client.query(
        `
          WITH doomed AS (
            SELECT name, id
            FROM pgboss.job
            WHERE name = $1
              AND state::text = ANY($2::text[])
              AND completed_on IS NOT NULL
              AND completed_on < now() - ($3::int * interval '1 second')
            ORDER BY completed_on ASC
            LIMIT $4
            FOR UPDATE SKIP LOCKED
          )
          DELETE FROM pgboss.job AS job
          USING doomed
          WHERE job.name = doomed.name
            AND job.id = doomed.id
          RETURNING job.id
        `,
        [queueName, TERMINAL_STATES, deleteAfterSeconds, this.batchSize],
      );
      await client.query("COMMIT");
      return result.rowCount || 0;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async #deleteAuxiliaryRows(table, timestampColumn, retentionDays) {
    const allowed = new Set(["queue_stats", "warning"]);
    if (!allowed.has(table)) throw new Error("Unsupported pg-boss auxiliary table");
    const column = timestampColumn === "captured_on" ? "captured_on" : "created_on";

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'`);
      await client.query(`SET LOCAL statement_timeout = '${this.statementTimeoutMs}ms'`);
      const result = await client.query(
        `
          DELETE FROM pgboss.${table}
          WHERE ${column} < now() - ($1::int * interval '1 day')
        `,
        [retentionDays],
      );
      await client.query("COMMIT");
      return result.rowCount || 0;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      if (error?.code === "42P01") return 0;
      throw error;
    } finally {
      client.release();
    }
  }
}

const pgBossRetention = new PgBossRetention();
export default pgBossRetention;
