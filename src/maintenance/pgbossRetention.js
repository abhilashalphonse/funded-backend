import pool from "../config/postgres.js";
import env from "../config/env.js";
import { PG_BOSS_QUEUE_POLICIES } from "../config/pgbossQueues.js";

const TERMINAL_STATES = Object.freeze(["completed", "cancelled", "failed"]);
const QUEUE_STATS_RETENTION_DAYS = 1;
const WARNING_RETENTION_DAYS = 7;
const RETENTION_INDEX_NAME = "job_common_retention_i1";

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
    const sizeResult = await this.#auditQuery(`
      SELECT
        relname AS relation,
        relkind AS "relationKind",
        pg_total_relation_size(c.oid)::bigint AS bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'pgboss'
        AND c.relkind IN ('r', 'p')
      ORDER BY bytes DESC
    `);

    const queueResult = await this.#auditQuery(`
      SELECT
        name,
        retention_seconds AS "retentionSeconds",
        deletion_seconds AS "deleteAfterSeconds",
        table_name AS "tableName",
        deferred_count AS "deferredCount",
        queued_count AS "queuedCount",
        active_count AS "activeCount",
        failed_count AS "failedCount",
        total_count AS "totalCount",
        monitor_on AS "monitorOn",
        maintain_on AS "maintainOn"
      FROM pgboss.queue
      ORDER BY name
    `);

    const estimateResult = await this.#auditQuery(`
      SELECT
        relname AS relation,
        n_live_tup::bigint AS "estimatedRows",
        n_dead_tup::bigint AS "estimatedDeadRows"
      FROM pg_stat_user_tables
      WHERE schemaname = 'pgboss'
      ORDER BY n_live_tup DESC
    `);

    const candidates = {};
    const candidateErrors = {};
    for (const [queueName, policy] of Object.entries(PG_BOSS_QUEUE_POLICIES)) {
      try {
        const result = await this.#auditQuery(
          `
            SELECT COUNT(*)::bigint AS count
            FROM pgboss.job_common
            WHERE name = $1
              AND state IN ('completed', 'cancelled', 'failed')
              AND completed_on IS NOT NULL
              AND completed_on < now() - ($2::int * interval '1 second')
          `,
          [queueName, policy.deleteAfterSeconds],
        );
        candidates[queueName] = Number(result.rows[0]?.count || 0);
      } catch (error) {
        if (["55P03", "57014"].includes(error?.code)) {
          candidates[queueName] = null;
          candidateErrors[queueName] = {
            code: error.code,
            message: error.message,
          };
          continue;
        }
        throw error;
      }
    }

    return {
      relations: sizeResult.rows.map(row => ({
        relation: row.relation,
        relationKind: row.relationKind,
        bytes: Number(row.bytes || 0),
      })),
      tableEstimates: estimateResult.rows.map(row => ({
        relation: row.relation,
        estimatedRows: Number(row.estimatedRows || 0),
        estimatedDeadRows: Number(row.estimatedDeadRows || 0),
      })),
      queues: queueResult.rows,
      cleanupCandidates: candidates,
      cleanupCandidateErrors: candidateErrors,
    };
  }

  async #auditQuery(text, values = []) {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'`);
      await client.query(`SET LOCAL statement_timeout = '${Math.max(this.statementTimeoutMs, 10000)}ms'`);
      const result = await client.query(text, values);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async cleanupIndexStatus() {
    const result = await this.db.query(`
      SELECT
        c.relname AS name,
        i.indisvalid AS valid,
        pg_relation_size(c.oid)::bigint AS bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE n.nspname = 'pgboss'
        AND c.relname = $1
    `, [RETENTION_INDEX_NAME]);

    if (!result.rows.length) return { exists: false, valid: false, bytes: 0 };
    return {
      exists: true,
      valid: Boolean(result.rows[0].valid),
      bytes: Number(result.rows[0].bytes || 0),
    };
  }

  async prepareCleanupIndex({ statementTimeoutMs = 180000 } = {}) {
    const current = await this.cleanupIndexStatus();
    if (current.exists && current.valid) return { created: false, ...current };

    const client = await this.db.connect();
    try {
      await client.query(`SET lock_timeout = '${Math.max(this.lockTimeoutMs, 5000)}ms'`);
      await client.query(`SET statement_timeout = '${statementTimeoutMs}ms'`);

      if (current.exists && !current.valid) {
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS pgboss.${RETENTION_INDEX_NAME}`);
      }

      await client.query(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS ${RETENTION_INDEX_NAME}
        ON pgboss.job_common (name, completed_on, id)
        WHERE state IN ('completed', 'cancelled', 'failed')
          AND completed_on IS NOT NULL
      `);

      const ready = await this.cleanupIndexStatus();
      if (!ready.valid) throw new Error("pg-boss retention index was created but is not valid");
      return { created: true, ...ready };
    } finally {
      try { await client.query("RESET lock_timeout"); } catch {}
      try { await client.query("RESET statement_timeout"); } catch {}
      client.release();
    }
  }

  async runOnce({ maxBatches = this.maxBatchesPerRun } = {}) {
    if (this.running) return { skipped: true, reason: "already-running" };
    this.running = true;
    const startedAt = new Date().toISOString();
    const deletedByQueue = {};

    try {
      const deferredQueues = {};
      for (const [queueName, policy] of Object.entries(PG_BOSS_QUEUE_POLICIES)) {
        let deleted = 0;
        try {
          for (let batch = 0; batch < maxBatches; batch += 1) {
            const count = await this.#deleteTerminalBatch(queueName, policy.deleteAfterSeconds);
            deleted += count;
            if (count < this.batchSize) break;
          }
        } catch (error) {
          if (["55P03", "57014"].includes(error?.code)) {
            deferredQueues[queueName] = {
              code: error.code,
              message: error.message,
            };
          } else {
            throw error;
          }
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
        deferredQueues,
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
            SELECT id
            FROM pgboss.job_common
            WHERE name = $1
              AND state IN ('completed', 'cancelled', 'failed')
              AND completed_on IS NOT NULL
              AND completed_on < now() - ($2::int * interval '1 second')
            LIMIT $3
            FOR UPDATE SKIP LOCKED
          )
          DELETE FROM pgboss.job_common AS job
          USING doomed
          WHERE job.name = $1
            AND job.id = doomed.id
          RETURNING job.id
        `,
        [queueName, deleteAfterSeconds, this.batchSize],
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
