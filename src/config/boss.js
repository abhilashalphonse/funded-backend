import { createRequire } from "module";
import env from "./env.js";

const require = createRequire(import.meta.url);

const PgBossPackage = require("pg-boss");

const PgBoss = PgBossPackage.PgBoss;
if (typeof PgBoss !== "function") {
  throw new Error("PgBoss constructor not found in pg-boss export");
}

const boss = new PgBoss({
  connectionString: env.POSTGRES_URL
});

export default boss;