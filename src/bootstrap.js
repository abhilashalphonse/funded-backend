import dotenv from "dotenv";
dotenv.config();

import { connectDatabase } from "./config/database.js";
import boss from "./config/boss.js";
import pool from "./config/postgres.js";
import redis from "./config/redis.js";
import { ensurePaymentProviderIndex } from "./models/payment.model.js";
import { ensureDefaultKnowledgeBase } from "./support/knowledgeBase.service.js";
import { PG_BOSS_QUEUE_NAMES, PG_BOSS_QUEUE_POLICIES } from "./config/pgbossQueues.js";

export async function bootstrap() {
  await connectDatabase();
  await ensurePaymentProviderIndex();
  await ensureDefaultKnowledgeBase();

  await boss.start();

  // Explicit queue retention is important because pg-boss defaults retain
  // completed jobs for 7 days and queued/retry jobs for 14 days. Those defaults
  // are unnecessarily large for ACG's transport-only event queues.
  for (const queueName of PG_BOSS_QUEUE_NAMES) {
    const policy = PG_BOSS_QUEUE_POLICIES[queueName];
    await boss.createQueue(queueName, policy);
    // createQueue is intentionally idempotent and does not change an existing
    // queue's options, so updateQueue applies the launch policy to deployments
    // that already have these queues.
    await boss.updateQueue(queueName, policy);
  }

  await pool.query("SELECT 1");

  if (redis.configured) {
    try {
      await redis.ping();
      console.log("[redis] Upstash hot-state connection ready");
    } catch (error) {
      // Snapshot projection has a safe direct-processing fallback so Redis
      // outages do not block trading lifecycle processing.
      console.warn("[redis] Upstash unavailable at startup; snapshot pipeline is degraded", {
        message: error?.message,
        code: error?.code,
      });
    }
  } else {
    console.warn("[redis] Upstash is not configured; snapshot pipeline is using direct fallback");
  }
}
