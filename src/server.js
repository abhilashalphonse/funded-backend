import app from "./app.js";
import { bootstrap } from "./bootstrap.js";
import EventIngestionWorker from "./workers/event-ingestion.worker.js";
import StateEngineWorker from "./workers/state-engine-worker.js";
import { CommandWorker } from "./workers/command-worker.js";
import { PaymentActivationWorker } from "./workers/payment-activation.worker.js";
import { TradingCredentialEmailWorker } from "./workers/trading-credential-email.worker.js";
import boss from "./config/boss.js";
import env from "./config/env.js";
import EventService from "./apis/services/event.service.js";
import simulatorEngine from "./simulator/engine.js";
import pgBossRetention from "./maintenance/pgbossRetention.js";

async function startWorkers() {
  const ingestion = new EventIngestionWorker(boss);
  const stateEngine = new StateEngineWorker(boss);
  const commandWorker = new CommandWorker(boss);
  const paymentActivationWorker = new PaymentActivationWorker(boss);
  const tradingCredentialEmailWorker = new TradingCredentialEmailWorker(boss);

  await ingestion.start();
  await stateEngine.start();
  await commandWorker.start();
  await paymentActivationWorker.start();
  await tradingCredentialEmailWorker.start();

  pgBossRetention.start();
  console.log("ACG Funded workers started");
}

function startApi() {
  if (env.ENABLE_SIMULATOR_ROUTES) {
    simulatorEngine.on("snapshot", async (event) => {
      try {
        await EventService.receive(event);
      } catch (error) {
        console.error("Failed to queue simulator snapshot:", error);
      }
    });
  }

  app.listen(env.PORT, () => {
    console.log(`ACG Funded API running on port ${env.PORT}`);
  });
}

async function start() {
  try {
    await bootstrap();

    if (env.RUNTIME_ROLE === "all" || env.RUNTIME_ROLE === "worker") {
      await startWorkers();
    }

    if (env.RUNTIME_ROLE === "all" || env.RUNTIME_ROLE === "api") {
      startApi();
    }

    console.log(`ACG Funded runtime role: ${env.RUNTIME_ROLE}`);
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
}

start();
