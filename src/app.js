import express from "express";
import tradeWebhookRoutes from "./apis/routes/tradeWebhook.routes.js";
import paymentRoutes from "./apis/routes/payment.routes.js";
import simulatorRoutes from "./simulator/api.js";
import Account from "./accounts/account.model.js";
import simulatorEngine from "./simulator/engine.js";
import boss from "./config/boss.js";
import { COMMAND_QUEUE_NAME } from "./workers/state-engine/commandQueue.js";

const app = express();
app.use(express.json());
app.use("/api", tradeWebhookRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/simulator", simulatorRoutes);

app.get("/health", (req, res) => res.json({ success: true, message: "MT5 MVP API is running" }));

// Local MVP provisioning endpoint. Keep administrator-only before production exposure.
app.post("/api/accounts", async (req, res, next) => {
  try {
    const { accountId, accountSize, initialDeposit, rules, leverage = 100 } = req.body ?? {};
    if (!accountId || !accountSize || !rules?.phases?.length) return res.status(400).json({ success: false, message: "accountId, accountSize, and rules.phases are required" });
    const deposit = Number(initialDeposit ?? accountSize);
    const account = await Account.create({ accountId: String(accountId), challengeType: "TWO_STEP", accountSize: Number(accountSize), initialDeposit: deposit, rules, leverage, status: "ACTIVE", enabled: true, balance: deposit, equity: deposit, dailyStartEquity: deposit });
    const simulated = await simulatorEngine.provisionAccount({ accountId: account.accountId, balance: deposit, leverage });
    account.login = simulated.login;
    account.platformAccountId = String(simulated.login);
    await account.save();
    return res.status(201).json({ success: true, data: account });
  } catch (error) { next(error); }
});

app.post("/api/accounts/:accountId/retry-command", async (req, res, next) => {
  try {
    const account = await Account.findOne({ accountId: req.params.accountId });
    if (!account) return res.status(404).json({ success: false, message: "Account not found" });
    if (!account.commandPending) return res.status(409).json({ success: false, message: "No command is pending for this account" });
    const jobId = await boss.send(COMMAND_QUEUE_NAME, { command: account.commandPending, accountId: account.accountId, timestamp: new Date(), metadata: { balance: account.balance, equity: account.equity, status: account.status } });
    return res.status(202).json({ success: true, jobId });
  } catch (error) { next(error); }
});

app.post("/api/users", (req, res) => {
  const { name, age } = req.body;
  if (!name || age === undefined) return res.status(400).json({ success: false, message: "Name and age are required." });
  res.status(201).json({ success: true, message: "User created successfully.", data: { id: Date.now(), name, age } });
});

app.use((error, req, res, next) => {
  console.error("API error:", error);
  res.status(error.status || 500).json({ success: false, message: error.message ?? "Internal server error" });
});

export default app;
