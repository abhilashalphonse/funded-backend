import { Pool } from "pg";
import env from "./env.js";

const pool = new Pool({
  connectionString: env.POSTGRES_URL,
  max: 10,
});

export default pool;
