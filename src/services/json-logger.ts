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
    if (this.config.enableJsonLogs) {
      this.ensureLogDir();
    }
  }

  /**
   * Ensure log directory exists (only called when JSON logging is enabled)
   */
  private ensureLogDir(): void {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch (error) {
      // Log the error but don't crash the bot — JSON logging is non-critical
      logError(`Failed to create log directory "${this.logDir}":`, error);
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
   * Calculate realized PnL from execution results.
   *
   * In a correctly executed two-leg arb we hold one UP token and one DOWN token
   * with the same endTime. Exactly one of them pays out 1.0 USDC regardless of
   * market direction — the other expires at 0. So the guaranteed profit on a
   * fully filled trade is always: pnl = 1.0 - sumPrice.
   *
   * The previous implementation tried to figure out "which side won" and fell
   * into a logic trap where upWon && downWon are BOTH true (one market resolved
   * UP, the other DOWN), causing the else branch (total loss) to never fire but
   * the positive branch to fire twice — double-counting wins.
   */
  private calculateRealizedPnL(log: MarketPairLog): number {
    if (!log.finalResolution) return 0;

    let totalPnL = 0;
    for (const execution of log.executionResults) {
      if (execution.status === "filled") {
        // Both legs filled: guaranteed payout regardless of which side won
        totalPnL += 1.0 - execution.prices.sumPrice;
      } else if (execution.status === "partial_unwind") {
        // One leg was bought and then immediately sold at $0.01 to unwind.
        // Approximate loss: the cost of the filled leg with no offsetting payout.
        totalPnL -= execution.prices.sumPrice / 2;
      }
      // "failed" / "canceled" = no position taken, zero PnL impact
    }

    return totalPnL;
  }

  /**
   * Save log to JSON file (async, fire-and-forget).
   * fs.writeFileSync blocks the entire Node.js event loop on every sync detection
   * event, adding latency to the arb detection loop. Using the async API keeps the
   * event loop free during disk I/O.
   */
  private saveLog(log: MarketPairLog): void {
    const filename = `market-pair-${log.marketPairId}-${log.endTime}.json`;
    const filepath = path.join(this.logDir, filename);
    fs.promises.writeFile(filepath, JSON.stringify(log, null, 2)).catch((error) => {
      logError("Failed to save JSON log:", error);
    });
    logDebug(`Saving JSON log: ${filename}`);
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
