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

    // Keep process alive
    process.stdin.resume();

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      logInfo("Received SIGINT, shutting down gracefully...");
      await orchestrator.stop();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      logInfo("Received SIGTERM, shutting down gracefully...");
      await orchestrator.stop();
      process.exit(0);
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
