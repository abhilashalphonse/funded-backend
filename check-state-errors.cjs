require("dotenv").config({ override: true });
const { Pool } = require("pg");

(async () => {
  const pool = new Pool({ connectionString: process.env.POSTGRES_URL });

  const result = await pool.query(`
    SELECT
      id,
      name,
      state,
      data,
      retry_count,
      retry_limit,
      created_on,
      started_on,
      completed_on,
      output
    FROM pgboss.job
    WHERE name = 'state-events'
      AND data->>'eventId' IN (
        SELECT event_id
        FROM (
          SELECT
            'acg-trader:' || payload->>'dummy' AS event_id
          FROM pgboss.job
          LIMIT 0
        ) q
      )
    LIMIT 0
  `).catch(() => null);

  const jobs = await pool.query(`
    SELECT
      id,
      state,
      data,
      retry_count,
      retry_limit,
      created_on,
      started_on,
      completed_on,
      output
    FROM pgboss.job
    WHERE name = 'state-events'
      AND state IN ('retry', 'failed')
    ORDER BY created_on DESC
    LIMIT 20
  `);

  console.dir(jobs.rows, { depth: null });

  await pool.end();
})();
