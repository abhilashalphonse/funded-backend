require("dotenv").config({ override: true });
const { Pool } = require("pg");

(async () => {
  const pool = new Pool({ connectionString: process.env.POSTGRES_URL });

  const result = await pool.query(`
    SELECT
      name,
      state,
      COUNT(*)::int AS count
    FROM pgboss.job
    WHERE name IN ('incoming-events', 'state-events', 'account-commands')
    GROUP BY name, state
    ORDER BY name, state
  `);

  console.table(result.rows);

  await pool.end();
})();
