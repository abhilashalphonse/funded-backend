import dotenv from "dotenv";
dotenv.config();

import { connectDatabase } from "./config/database.js";
import boss from "./config/boss.js";
import pool from "./config/postgres.js";
import { ensurePaymentProviderIndex } from "./models/payment.model.js";

export async function bootstrap() {
  await connectDatabase();
  await ensurePaymentProviderIndex();

  await boss.start();
  await boss.createQueue("incoming-events");
  await boss.createQueue("state-events");
  await boss.createQueue("account-commands");

  await pool.query("SELECT 1");
}