import { Pool } from "pg";
import env from "./env.js";

const pool = new Pool({
  connectionString: env.POSTGRES_URL,
  max: env.POSTGRES_POOL_MAX,
  connectionTimeoutMillis: env.POSTGRES_CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: 30000,
  keepAlive: true,
});

export default pool;
