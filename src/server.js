import app from "./app.js";
import { bootstrap } from "./bootstrap.js";
import EventIngestionWorker from "./workers/event-ingestion.worker.js";
import StateEngineWorker from "./workers/state-engine-worker.js";
import { CommandWorker } from "./workers/command-worker.js";
import boss from "./config/boss.js";

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    // 1. initialize system ONCE 
    await bootstrap();

    // 2. workers
    const ingestion = new EventIngestionWorker(boss); 
    const stateEngine = new StateEngineWorker(boss); 
    const commandWorker = new CommandWorker(boss);

    await ingestion.start(); 
    await stateEngine.start();
    await commandWorker.start();
    

    


    // 3. server
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
}

start();