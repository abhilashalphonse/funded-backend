import test from "node:test";
import assert from "node:assert/strict";

import { pgBossSupervisionEnabled } from "../src/config/pgbossRuntime.js";

test("worker-capable runtimes enable pg-boss supervision", () => {
  assert.equal(pgBossSupervisionEnabled("all"), true);
  assert.equal(pgBossSupervisionEnabled("worker"), true);
});

test("API-only runtime keeps pg-boss supervision disabled", () => {
  assert.equal(pgBossSupervisionEnabled("api"), false);
});
