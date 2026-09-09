import { Pool } from "pg";
import env from "./env.js";

const pool = new Pool({
  host: env.POSTGRES_HOST,
  port: Number(env.POSTGRES_PORT || 5432),
  user: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  database: env.POSTGRES_DATABASE,
  max: 10
});

export default pool;