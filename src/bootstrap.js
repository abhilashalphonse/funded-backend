import dotenv from "dotenv";
dotenv.config();

import { connectDatabase } from "./config/database.js";
import boss from "./config/boss.js";
import pool from "./config/postgres.js";

export async function bootstrap() {
  await connectDatabase();

  await boss.start();
  await boss.createQueue("incoming-events");
  await boss.createQueue("state-events");
  await boss.createQueue("account-commands");

  await pool.query("SELECT 1");
}