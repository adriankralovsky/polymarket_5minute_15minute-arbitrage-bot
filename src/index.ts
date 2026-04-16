/**
 * BTC 5-15 minute arbitrage bot main entry point
 */

import "dotenv/config";
import { ArbitrageOrchestrator } from "./services/arbitrage-orchestrator";
import { logInfo, logError, setLogLevel } from "./utils/logger";

async function main(): Promise<void> {
  try {
    // Set log level from environment
    if (process.env.LOG_LEVEL) {
      setLogLevel(process.env.LOG_LEVEL);
    }

    logInfo("Starting BTC 5-15 minute arbitrage bot");

    const orchestrator = new ArbitrageOrchestrator();

    // Start the bot
    await orchestrator.start();

    // Keep process alive via open handles (MongoDB + WebSocket).
    // process.stdin.resume() is not needed and buffers stdin indefinitely.

    // Graceful shutdown — shared handler to prevent double-stop on rapid signals.
    let isShuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      logInfo(`Received ${signal}, shutting down gracefully...`);
      try {
        await orchestrator.stop();
      } catch (err) {
        logError("Error during graceful shutdown:", err);
      } finally {
        process.exit(0);
      }
    };

    process.on("SIGINT",  () => { void shutdown("SIGINT");  });
    process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

    // Catch unhandled promise rejections to prevent silent crashes
    process.on("unhandledRejection", (reason) => {
      logError("Unhandled promise rejection:", reason);
    });
  } catch (error) {
    logError("Fatal error in main:", error);
    process.exit(1);
  }
}

main().catch((err) => {
  logError("Fatal error:", err);
  process.exit(1);
});
