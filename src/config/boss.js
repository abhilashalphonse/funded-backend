import { createRequire } from "module";
import env from "./env.js";

const require = createRequire(import.meta.url);
const PgBossPackage = require("pg-boss");
const PgBoss = PgBossPackage.PgBoss;

if (typeof PgBoss !== "function") {
  throw new Error("PgBoss constructor not found in pg-boss export");
}

const sendOnlyRuntime = env.RUNTIME_ROLE === "api";

const boss = new PgBoss({
  connectionString: env.POSTGRES_URL,
  max: env.POSTGRES_POOL_MAX,
  connectionTimeoutMillis: env.POSTGRES_CONNECTION_TIMEOUT_MS,
  application_name: sendOnlyRuntime ? "acg-funded-api-pgboss" : "acg-funded-worker-pgboss",
  // Queue monitoring/supervision is disabled on every runtime. The current
  // Supabase/Postgres deployment has shown lock contention inside pg-boss
  // Boss.supervise() -> #monitor(), so normal job consumption must not compete
  // with queue-monitor maintenance. Workers still process jobs via boss.work().
  supervise: false,
  schedule: !sendOnlyRuntime,
  persistQueueStats: false,
  // Polling is sufficient for these queues and is compatible with pooled
  // Postgres endpoints that do not provide session-pinned LISTEN/NOTIFY.
  useListenNotify: false,
});

boss.on("error", (error) => {
  console.error("[pg-boss] runtime error:", {
    name: error?.name,
    message: error?.message,
    code: error?.code,
    detail: error?.detail,
    hint: error?.hint,
    severity: error?.severity,
    syscall: error?.syscall,
    hostname: error?.hostname,
    stack: error?.stack,
  });
});

export default boss;
