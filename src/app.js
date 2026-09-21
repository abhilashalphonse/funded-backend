import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import tradeWebhookRoutes from "./apis/routes/tradeWebhook.routes.js";
import acgTraderWebhookRoutes from "./apis/routes/acgTraderWebhook.routes.js";
import paymentRoutes from "./apis/routes/payment.routes.js";
import customerRoutes from "./apis/routes/customer.routes.js";
import analyticsRoutes from "./apis/routes/analytics.routes.js";
import supportRoutes from "./apis/routes/support.routes.js";
import resendWebhookRoutes from "./apis/routes/resendWebhook.routes.js";
import adminRoutes from "./apis/routes/admin.routes.js";
import simulatorRoutes from "./simulator/api.js";
import Account from "./accounts/account.model.js";
import boss from "./config/boss.js";
import env from "./config/env.js";
import accountSnapshotService from "./apis/services/accountSnapshot.service.js";
import { COMMAND_QUEUE_NAME } from "./workers/state-engine/commandQueue.js";
import { configuredTradingProvider } from "./connectors/trading/registry.js";
import { provisionTradingAccount } from "./connectors/trading/account-provisioning.js";
import pgBossRetention from "./maintenance/pgbossRetention.js";

const app = express();

app.disable("x-powered-by");
app.use(helmet());
app.use(compression());
app.use(cors({
  origin(origin, callback) {
    if (!origin || env.CORS_ORIGINS.includes(origin)) return callback(null, true);
    const error = new Error("Origin is not allowed by CORS.");
    error.status = 403;
    return callback(error);
  },
  credentials: true,
}));
app.use("/api/webhooks/resend", express.raw({ type: "application/json", limit: "256kb" }), resendWebhookRoutes);
app.use(express.json({ limit: "128kb" }));

app.use("/api", acgTraderWebhookRoutes);
app.use("/api", tradeWebhookRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/customer", customerRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/admin", adminRoutes);
if (env.ENABLE_SIMULATOR_ROUTES) app.use("/simulator", simulatorRoutes);

app.get("/health", (req, res) => res.json({
  success: true,
  message: "ACG Funded API is running",
  environment: env.NODE_ENV,
  runtimeRole: env.RUNTIME_ROLE,
  tradingProvider: configuredTradingProvider(),
  snapshotPipeline: accountSnapshotService.health(),
  pgBossRetention: pgBossRetention.health(),
  acgTraderWebhookConfigured: Boolean(env.ACG_TRADER_WEBHOOK_SECRET),
  customerAuthConfigured: Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
  adminAccessConfigured: env.ADMIN_EMAILS.length > 0,
  supportAiConfigured: Boolean(env.OPENAI_API_KEY),
  supportEmailConfigured: Boolean(process.env.RESEND_API_KEY && process.env.RESEND_WEBHOOK_SECRET && (process.env.SUPPORT_EMAIL_FROM || process.env.TRADING_EMAIL_FROM)),
  supportModel: env.OPENAI_SUPPORT_MODEL,
  tradingCredentialVaultConfigured: Boolean(process.env.TRADING_CREDENTIAL_ENCRYPTION_KEY),
  tradingCredentialEmailConfigured: Boolean(process.env.RESEND_API_KEY && process.env.TRADING_EMAIL_FROM),
  simulatorRoutesEnabled: env.ENABLE_SIMULATOR_ROUTES,
  localAdminRoutesEnabled: env.ENABLE_LOCAL_ADMIN_ROUTES,
}));

if (env.ENABLE_LOCAL_ADMIN_ROUTES) {
  // Local/operator-only provisioning endpoint. Disabled by default in production.
  app.post("/api/accounts", async (req, res, next) => {
    try {
      const { accountId, accountSize, initialDeposit, rules, leverage = 100, ownerExternalRef, platform } = req.body ?? {};
      if (!accountId || !accountSize || !rules?.phases?.length) {
        return res.status(400).json({ success: false, message: "accountId, accountSize, and rules.phases are required" });
      }
      const deposit = Number(initialDeposit ?? accountSize);
      const account = await Account.create({
        accountId: String(accountId),
        ownerExternalRef: String(ownerExternalRef || `local:${accountId}`),
        accountMode: "CHALLENGE",
        challengeType: rules.phases.length > 1 ? "TWO_STEP" : "ONE_STEP",
        accountSize: Number(accountSize),
        initialDeposit: deposit,
        rules,
        leverage,
        platform: platform || configuredTradingProvider(),
        status: "NEW",
        enabled: false,
        balance: deposit,
        equity: deposit,
        dailyStartEquity: deposit,
      });
      await provisionTradingAccount(account, { phase: 1, accountType: "CHALLENGE" });
      account.status = "ACTIVE";
      account.enabled = true;
      await account.save();
      return res.status(201).json({ success: true, data: account });
    } catch (error) { next(error); }
  });

  app.post("/api/accounts/:accountId/retry-command", async (req, res, next) => {
    try {
      const account = await Account.findOne({ accountId: req.params.accountId });
      if (!account) return res.status(404).json({ success: false, message: "Account not found" });
      if (!account.commandPending) return res.status(409).json({ success: false, message: "No command is pending for this account" });
      const jobId = await boss.send(COMMAND_QUEUE_NAME, {
        command: account.commandPending,
        accountId: account.accountId,
        timestamp: new Date(),
        metadata: { balance: account.balance, equity: account.equity, status: account.status },
      });
      return res.status(202).json({ success: true, jobId });
    } catch (error) { next(error); }
  });

  app.post("/api/users", (req, res) => {
    const { name, age } = req.body;
    if (!name || age === undefined) return res.status(400).json({ success: false, message: "Name and age are required." });
    res.status(201).json({ success: true, message: "User created successfully.", data: { id: Date.now(), name, age } });
  });
}

app.use((error, req, res, next) => {
  console.error("API error:", error);
  res.status(error.status || 500).json({
    success: false,
    message: error.message ?? "Internal server error",
    code: error.code,
    retryable: error.retryable === true,
  });
});

export default app;
