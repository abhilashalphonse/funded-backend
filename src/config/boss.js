import { createRequire } from "module";
import env from "./env.js";

const require = createRequire(import.meta.url);

const PgBossPackage = require("pg-boss");

const PgBoss = PgBossPackage.PgBoss;
if (typeof PgBoss !== "function") {
  throw new Error("PgBoss constructor not found in pg-boss export");
}

const boss = new PgBoss({
  connectionString: env.POSTGRES_URL,
  max: env.POSTGRES_POOL_MAX,
  connectionTimeoutMillis: env.POSTGRES_CONNECTION_TIMEOUT_MS,
  application_name: "acg-funded-pgboss",
  // Polling is sufficient for these queues and is compatible with pooled
  // Postgres endpoints that do not provide session-pinned LISTEN/NOTIFY.
  useListenNotify: false,
});

boss.on("error", (error) => {
  console.error("[pg-boss] runtime error:", {
    message: error?.message,
    code: error?.code,
    syscall: error?.syscall,
    hostname: error?.hostname,
  });
});

export default boss;
