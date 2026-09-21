import dotenv from "dotenv";
dotenv.config();

import { connectDatabase } from "./config/database.js";
import boss from "./config/boss.js";
import pool from "./config/postgres.js";
import redis from "./config/redis.js";
import { ensurePaymentProviderIndex } from "./models/payment.model.js";
import { ensureDefaultKnowledgeBase } from "./support/knowledgeBase.service.js";

export async function bootstrap() {
  await connectDatabase();
  await ensurePaymentProviderIndex();
  await ensureDefaultKnowledgeBase();

  await boss.start();
  await boss.createQueue("incoming-events");
  await boss.createQueue("state-events");
  await boss.createQueue("account-commands");
  await boss.createQueue("payment-activation");
  await boss.createQueue("trading-credential-email");

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
