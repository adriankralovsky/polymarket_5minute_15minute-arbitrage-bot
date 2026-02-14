/**
 * JSON log file system for market pairs (requirement 9.2)
 */

import * as fs from "fs";
import * as path from "path";
import type { MarketData, ArbitrageOpportunity, TradeExecution } from "../types";
import { logError, logDebug } from "../utils/logger";
import { getConfig } from "../config";

interface MarketPairLog {
  marketPairId: string;
  startTime: number;
  endTime: number;
  beatPrices: {
    beat5m: number;
    beat15m: number;
  };
  detectedDirection: {
    upMarket: "5m" | "15m";
    downMarket: "5m" | "15m";
  } | null;
  tradeAttempts: Array<{
    timestamp: number;
    opportunity: ArbitrageOpportunity;
    executed: boolean;
  }>;
  executionResults: TradeExecution[];
  finalResolution: {
    finishPrice: number;
    result5m: "UP" | "DOWN";
    result15m: "UP" | "DOWN";
  } | null;
  realizedPnL: number;
}

export class JsonLogger {
  private config = getConfig();
  private logDir: string;
  private currentLogs: Map<string, MarketPairLog> = new Map();

  constructor() {
    this.logDir = this.config.logDir;
    this.ensureLogDir();
  }

  /**
   * Ensure log directory exists
   */
  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Get or create market pair log
   */
  private getOrCreateLog(market5m: MarketData, market15m: MarketData): MarketPairLog {
    const pairId = `${market5m.marketId}-${market15m.marketId}`;
    if (!this.currentLogs.has(pairId)) {
      this.currentLogs.set(pairId, {
        marketPairId: pairId,
        startTime: Math.min(market5m.startTime, market15m.startTime),
        endTime: market5m.endTime,
        beatPrices: {
          beat5m: market5m.beatPrice?.value || 0,
          beat15m: market15m.beatPrice?.value || 0,
        },
        detectedDirection: null,
        tradeAttempts: [],
        executionResults: [],
        finalResolution: null,
        realizedPnL: 0,
      });
    }
    return this.currentLogs.get(pairId)!;
  }

  /**
   * Log synchronized market detection
   */
  logSyncDetected(market5m: MarketData, market15m: MarketData, opportunity: ArbitrageOpportunity): void {
    if (!this.config.enableJsonLogs) return;

    const log = this.getOrCreateLog(market5m, market15m);
    log.detectedDirection = opportunity.direction;

    // Add trade attempt
    log.tradeAttempts.push({
      timestamp: Date.now(),
      opportunity,
      executed: false,
    });

    this.saveLog(log);
  }

  /**
   * Log trade execution
   */
  logTradeExecution(market5m: MarketData, market15m: MarketData, execution: TradeExecution): void {
    if (!this.config.enableJsonLogs) return;

    const log = this.getOrCreateLog(market5m, market15m);
    log.executionResults.push(execution);

    // Update trade attempt
    const lastAttempt = log.tradeAttempts[log.tradeAttempts.length - 1];
    if (lastAttempt) {
      lastAttempt.executed = true;
    }

    this.saveLog(log);
  }

  /**
   * Log final resolution
   */
  logFinalResolution(
    market5m: MarketData,
    market15m: MarketData,
    finishPrice: number,
    result5m: "UP" | "DOWN",
    result15m: "UP" | "DOWN",
  ): void {
    if (!this.config.enableJsonLogs) return;

    const log = this.getOrCreateLog(market5m, market15m);
    log.finalResolution = {
      finishPrice,
      result5m,
      result15m,
    };

    // Calculate realized PnL
    log.realizedPnL = this.calculateRealizedPnL(log);

    this.saveLog(log);
  }

  /**
   * Calculate realized PnL from execution results
   */
  private calculateRealizedPnL(log: MarketPairLog): number {
    if (!log.finalResolution) return 0;

    let totalPnL = 0;
    for (const execution of log.executionResults) {
      if (execution.status !== "filled") continue;

      // Determine which token won
      const upWon = log.finalResolution.result5m === "UP" || log.finalResolution.result15m === "UP";
      const downWon = log.finalResolution.result5m === "DOWN" || log.finalResolution.result15m === "DOWN";

      // Calculate PnL based on which tokens were bought
      if (execution.direction.upMarket === "5m" && upWon) {
        totalPnL += 1.0 - execution.prices.sumPrice; // UP token pays 1.0
      } else if (execution.direction.downMarket === "5m" && downWon) {
        totalPnL += 1.0 - execution.prices.sumPrice; // DOWN token pays 1.0
      } else if (execution.direction.upMarket === "15m" && upWon) {
        totalPnL += 1.0 - execution.prices.sumPrice;
      } else if (execution.direction.downMarket === "15m" && downWon) {
        totalPnL += 1.0 - execution.prices.sumPrice;
      } else {
        totalPnL -= execution.prices.sumPrice; // Lost trade
      }
    }

    return totalPnL;
  }

  /**
   * Save log to JSON file
   */
  private saveLog(log: MarketPairLog): void {
    try {
      const filename = `market-pair-${log.marketPairId}-${log.endTime}.json`;
      const filepath = path.join(this.logDir, filename);
      fs.writeFileSync(filepath, JSON.stringify(log, null, 2));
      logDebug(`Saved JSON log: ${filename}`);
    } catch (error) {
      logError("Failed to save JSON log:", error);
    }
  }

  /**
   * Load historical log for simulation
   */
  loadHistoricalLog(filepath: string): MarketPairLog | null {
    try {
      const content = fs.readFileSync(filepath, "utf-8");
      return JSON.parse(content) as MarketPairLog;
    } catch (error) {
      logError("Failed to load historical log:", error);
      return null;
    }
  }
}
