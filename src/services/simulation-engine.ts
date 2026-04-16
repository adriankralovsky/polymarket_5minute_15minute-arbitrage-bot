/**
 * Simulation/backtesting engine (requirement 10)
 * Replays historical market data and runs arbitrage logic
 */

import type { HistoricalMarketData, SimulationResult, ArbitrageOpportunity } from "../types";
import { ArbitrageDetector } from "./arbitrage-detector";
import { logInfo, logDebug } from "../utils/logger";
import { getConfig } from "../config";
import type { MarketData, TradeParams, TradeExecution } from "../types";

/**
 * Dry-run trade executor for simulation — records the opportunity without
 * touching the CLOB API or requiring POLY_PRIVATE_KEY to be set.
 */
class SimulatedTradeExecutor {
  async executeTradeBatch(params: TradeParams): Promise<TradeExecution> {
    const sumPrice = params.upPrice + params.downPrice;
    return {
      tradeId:      `sim-${Date.now()}`,
      timestamp:    Date.now(),
      market5Id:    params.market5mId,
      market15Id:   params.market15mId,
      direction:    { upMarket: params.upMarket, downMarket: params.downMarket },
      prices:       { upPrice: params.upPrice, downPrice: params.downPrice, sumPrice },
      quantity:     params.quantity,
      latencyMs:    0,
      status:       "filled",
      pnlEstimate:  1.0 - sumPrice,
    };
  }
}

export class SimulationEngine {
  private detector: ArbitrageDetector;
  private executor: SimulatedTradeExecutor;
  private config = getConfig();

  constructor() {
    this.detector = new ArbitrageDetector();
    // Use the dry-run executor — real TradeExecutor requires POLY_PRIVATE_KEY and
    // would place real orders on Polymarket if ENABLE_TRADING=1 is set.
    this.executor = new SimulatedTradeExecutor();
  }

  /**
   * Run simulation on historical data
   */
  async simulate(historicalData: {
    market5m: HistoricalMarketData;
    market15m: HistoricalMarketData;
  }): Promise<SimulationResult> {
    logInfo("Starting simulation...");

    const result: SimulationResult = {
      totalTrades: 0,
      successfulTrades: 0,
      failedTrades: 0,
      winRate: 0,
      totalPnL: 0,
      pnlCurve: [],
      maxDrawdown: 0,
      latencySensitivity: [],
    };

    // Convert historical data to MarketData format
    const market5m = this.convertToMarketData(historicalData.market5m);
    const market15m = this.convertToMarketData(historicalData.market15m);

    // Replay price timeline
    const allTimestamps = new Set<number>();
    market5m.priceHistory.forEach((p) => allTimestamps.add(p.timestamp));
    market15m.priceHistory.forEach((p) => allTimestamps.add(p.timestamp));

    const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);

    let cumulativePnL = 0;
    let peakPnL = 0;

    for (const timestamp of sortedTimestamps) {
      // Update prices at this timestamp.
      // We want the most-recent snapshot whose timestamp <= current replay timestamp.
      // Array.find returns the *first* (oldest) match on an ascending array, which
      // would pin every price lookup to t=0. Iterate in reverse instead.
      const findLatestAt = (history: typeof market5m.priceHistory, ts: number) => {
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].timestamp <= ts) return history[i];
        }
        return undefined;
      };
      const price5m  = findLatestAt(market5m.priceHistory,  timestamp);
      const price15m = findLatestAt(market15m.priceHistory, timestamp);

      if (price5m) {
        market5m.upPrice = price5m.upPrice;
        market5m.downPrice = price5m.downPrice;
      }
      if (price15m) {
        market15m.upPrice = price15m.upPrice;
        market15m.downPrice = price15m.downPrice;
      }

      // Check for arbitrage
      const opportunity = this.detector.detectArbitrage(market5m, market15m);

      if (opportunity.exists && opportunity.prices) {
        result.totalTrades++;

        // Execute trade
        const tradeParams = {
          upTokenId:
            opportunity.direction!.upMarket === "5m"
              ? market5m.tokens.upTokenId
              : market15m.tokens.upTokenId,
          downTokenId:
            opportunity.direction!.downMarket === "5m"
              ? market5m.tokens.downTokenId
              : market15m.tokens.downTokenId,
          upMarket: opportunity.direction!.upMarket,
          downMarket: opportunity.direction!.downMarket,
          market5mId:  market5m.marketId,
          market15mId: market15m.marketId,
          upPrice: opportunity.prices.upPrice,
          downPrice: opportunity.prices.downPrice,
          quantity: this.config.defaultQuantity,
        };

        const execution = await this.executor.executeTradeBatch(tradeParams);

        if (execution.status === "filled") {
          result.successfulTrades++;

          // Calculate PnL based on final resolution
          const finalResult5m = historicalData.market5m.result;
          const finalResult15m = historicalData.market15m.result;

          let tradePnL = 0;
          if (
            (opportunity.direction!.upMarket === "5m" && finalResult5m === "UP") ||
            (opportunity.direction!.upMarket === "15m" && finalResult15m === "UP")
          ) {
            tradePnL = 1.0 - opportunity.prices.sumPrice; // UP token wins
          } else if (
            (opportunity.direction!.downMarket === "5m" && finalResult5m === "DOWN") ||
            (opportunity.direction!.downMarket === "15m" && finalResult15m === "DOWN")
          ) {
            tradePnL = 1.0 - opportunity.prices.sumPrice; // DOWN token wins
          } else {
            tradePnL = -opportunity.prices.sumPrice; // Lost
          }

          cumulativePnL += tradePnL;
          result.totalPnL = cumulativePnL;

          if (cumulativePnL > peakPnL) {
            peakPnL = cumulativePnL;
          }

          const drawdown = peakPnL - cumulativePnL;
          if (drawdown > result.maxDrawdown) {
            result.maxDrawdown = drawdown;
          }
        } else {
          result.failedTrades++;
        }

        // Update PnL curve
        result.pnlCurve.push({
          timestamp,
          cumulativePnL,
        });
      }
    }

    // Calculate win rate
    result.winRate =
      result.totalTrades > 0 ? result.successfulTrades / result.totalTrades : 0;

    // Latency sensitivity analysis
    result.latencySensitivity = this.analyzeLatencySensitivity(historicalData);

    logInfo("Simulation completed", {
      totalTrades: result.totalTrades,
      winRate: result.winRate,
      totalPnL: result.totalPnL,
    });

    return result;
  }

  /**
   * Convert historical data to MarketData format
   */
  private convertToMarketData(historical: HistoricalMarketData): MarketData {
    return {
      marketId: historical.marketId,
      marketType: historical.marketType,
      eventId: historical.marketId,
      slug: "",
      startTime: historical.startTime,
      endTime: historical.endTime,
      beatPrice: {
        value: historical.beatPrice,
        timestamp: historical.startTime,
        source: "calculated",
      },
      tokens: {
        upTokenId: `up_${historical.marketId}`,
        downTokenId: `down_${historical.marketId}`,
      },
      upPrice: historical.priceTimeline[0]?.upPrice || null,
      downPrice: historical.priceTimeline[0]?.downPrice || null,
      upLiquidity: 1000, // Default for simulation
      downLiquidity: 1000,
      finalFinishPrice: historical.finalFinishPrice,
      result: historical.result,
      priceHistory: historical.priceTimeline,
    };
  }

  /**
   * Analyze latency sensitivity
   */
  private analyzeLatencySensitivity(historicalData: {
    market5m: HistoricalMarketData;
    market15m: HistoricalMarketData;
  }): Array<{ latencyMs: number; successRate: number }> {
    const latencies = [10, 25, 50, 100, 200, 500];
    const results: Array<{ latencyMs: number; successRate: number }> = [];

    for (const latency of latencies) {
      // Simulate different latency scenarios
      // In a real implementation, this would replay with different execution delays
      const successRate = Math.max(0, 1 - latency / 1000); // Simplified model
      results.push({ latencyMs: latency, successRate });
    }

    return results;
  }
}
