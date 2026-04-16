/**
 * Simulation/backtesting entry point
 */

import "dotenv/config";
import { SimulationEngine } from "./services/simulation-engine";
import { JsonLogger } from "./services/json-logger";
import { logInfo, logError, setLogLevel } from "./utils/logger";
import * as fs from "fs";
import * as path from "path";
import { getConfig } from "./config";
import type { HistoricalMarketData } from "./types";

async function main(): Promise<void> {
  try {
    if (process.env.LOG_LEVEL) {
      setLogLevel(process.env.LOG_LEVEL);
    }

    const logDir = getConfig().logDir;
    const logFiles = fs.readdirSync(logDir).filter((f) => f.endsWith(".json"));

    if (logFiles.length === 0) {
      logError("No historical log files found in", logDir);
      process.exit(1);
    }

    logInfo(`Found ${logFiles.length} historical log files`);

    const logger = new JsonLogger();
    const engine = new SimulationEngine();

    for (const logFile of logFiles) {
      const filepath = path.join(logDir, logFile);
      const log = logger.loadHistoricalLog(filepath);

      if (!log) {
        logError(`Failed to load log: ${logFile}`);
        continue;
      }

      logInfo(`Simulating: ${logFile}`);

      // Convert log to historical market data format
      // This is a simplified conversion - in production, you'd need to reconstruct
      // the full market data from the log
      const historicalData: {
        market5m: HistoricalMarketData;
        market15m: HistoricalMarketData;
      } = {
        market5m: {
          marketId: log.marketPairId.split("-")[0],
          marketType: "5m",
          startTime: log.startTime,
          endTime: log.endTime,
          beatPrice: log.beatPrices.beat5m,
          priceTimeline: log.priceTimeline?.market5m ?? [],
          finalFinishPrice: log.finalResolution?.finishPrice || 0,
          result: log.finalResolution?.result5m || "PENDING",
        },
        market15m: {
          marketId: log.marketPairId.split("-")[1],
          marketType: "15m",
          startTime: log.startTime,
          endTime: log.endTime,
          beatPrice: log.beatPrices.beat15m,
          priceTimeline: log.priceTimeline?.market15m ?? [],
          finalFinishPrice: log.finalResolution?.finishPrice || 0,
          result: log.finalResolution?.result15m || "PENDING",
        },
      };

      const result = await engine.simulate(historicalData);

      logInfo(`Simulation results for ${logFile}:`, {
        totalTrades: result.totalTrades,
        winRate: result.winRate,
        totalPnL: result.totalPnL,
        maxDrawdown: result.maxDrawdown,
      });
    }
  } catch (error) {
    logError("Fatal error in simulation:", error);
    process.exit(1);
  }
}

main().catch((err) => {
  logError("Fatal error:", err);
  process.exit(1);
});
