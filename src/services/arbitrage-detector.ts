/**
 * Arbitrage detection engine with beat price comparison logic
 * Implements Cases A, B, and C from specification
 */

import type { MarketData, ArbitrageOpportunity, MarketType } from "../types";
import { logInfo, logDebug, logWarn } from "../utils/logger";
import { getConfig } from "../config";

export class ArbitrageDetector {
  private config = getConfig();

  /**
   * Detect arbitrage opportunity between synchronized markets
   * Requirement: endTime_5m == endTime_15m
   */
  detectArbitrage(market5m: MarketData, market15m: MarketData): ArbitrageOpportunity {
    // Validate markets are synchronized
    if (market5m.endTime !== market15m.endTime) {
      return {
        exists: false,
        case: null,
        direction: null,
        prices: null,
        beatPrices: null,
        endTime: null,
        timestamp: Date.now(),
        reason: `Markets not synchronized: endTime_5m=${market5m.endTime}, endTime_15m=${market15m.endTime}`,
      };
    }

    // Validate beat prices are available
    if (!market5m.beatPrice || !market15m.beatPrice) {
      return {
        exists: false,
        case: null,
        direction: null,
        prices: null,
        beatPrices: null,
        endTime: market5m.endTime,
        timestamp: Date.now(),
        reason: "Beat prices not available",
      };
    }

    // Validate executable prices are available
    if (
      market5m.upPrice === null ||
      market5m.downPrice === null ||
      market15m.upPrice === null ||
      market15m.downPrice === null
    ) {
      return {
        exists: false,
        case: null,
        direction: null,
        prices: null,
        beatPrices: {
          beat5m: market5m.beatPrice.value,
          beat15m: market15m.beatPrice.value,
        },
        endTime: market5m.endTime,
        timestamp: Date.now(),
        reason: "Executable prices not available",
      };
    }

    const beat5m = market5m.beatPrice.value;
    const beat15m = market15m.beatPrice.value;

    logDebug(`Analyzing arbitrage: beat5m=${beat5m}, beat15m=${beat15m}`);

    // Case A: beatPrice_15m > beatPrice_5m
    // Trade: BUY UP in 5m, BUY DOWN in 15m
    if (beat15m > beat5m) {
      const sumPrice = market5m.upPrice + market15m.downPrice;
      if (sumPrice < this.config.arbThreshold) {
        logInfo(
          `Case A arbitrage detected: sum=${sumPrice.toFixed(4)} < threshold=${this.config.arbThreshold}`,
        );
        return {
          exists: true,
          case: "A",
          direction: {
            upMarket: "5m",
            downMarket: "15m",
          },
          prices: {
            upPrice: market5m.upPrice,
            downPrice: market15m.downPrice,
            sumPrice,
          },
          beatPrices: {
            beat5m,
            beat15m,
          },
          endTime: market5m.endTime,
          timestamp: Date.now(),
        };
      } else {
        return {
          exists: false,
          case: "A",
          direction: {
            upMarket: "5m",
            downMarket: "15m",
          },
          prices: {
            upPrice: market5m.upPrice,
            downPrice: market15m.downPrice,
            sumPrice,
          },
          beatPrices: {
            beat5m,
            beat15m,
          },
          endTime: market5m.endTime,
          timestamp: Date.now(),
          reason: `Sum price ${sumPrice.toFixed(4)} >= threshold ${this.config.arbThreshold}`,
        };
      }
    }

    // Case B: beatPrice_5m > beatPrice_15m
    // Trade: BUY UP in 15m, BUY DOWN in 5m
    if (beat5m > beat15m) {
      const sumPrice = market15m.upPrice + market5m.downPrice;
      if (sumPrice < this.config.arbThreshold) {
        logInfo(
          `Case B arbitrage detected: sum=${sumPrice.toFixed(4)} < threshold=${this.config.arbThreshold}`,
        );
        return {
          exists: true,
          case: "B",
          direction: {
            upMarket: "15m",
            downMarket: "5m",
          },
          prices: {
            upPrice: market15m.upPrice,
            downPrice: market5m.downPrice,
            sumPrice,
          },
          beatPrices: {
            beat5m,
            beat15m,
          },
          endTime: market5m.endTime,
          timestamp: Date.now(),
        };
      } else {
        return {
          exists: false,
          case: "B",
          direction: {
            upMarket: "15m",
            downMarket: "5m",
          },
          prices: {
            upPrice: market15m.upPrice,
            downPrice: market5m.downPrice,
            sumPrice,
          },
          beatPrices: {
            beat5m,
            beat15m,
          },
          endTime: market5m.endTime,
          timestamp: Date.now(),
          reason: `Sum price ${sumPrice.toFixed(4)} >= threshold ${this.config.arbThreshold}`,
        };
      }
    }

    // Case C: beatPrice_5m == beatPrice_15m
    // Check both sums and execute the first valid
    const sum1 = market5m.upPrice + market15m.downPrice;
    const sum2 = market15m.upPrice + market5m.downPrice;

    if (sum1 < this.config.arbThreshold) {
      logInfo(
        `Case C arbitrage detected (option 1): sum=${sum1.toFixed(4)} < threshold=${this.config.arbThreshold}`,
      );
      return {
        exists: true,
        case: "C",
        direction: {
          upMarket: "5m",
          downMarket: "15m",
        },
        prices: {
          upPrice: market5m.upPrice,
          downPrice: market15m.downPrice,
          sumPrice: sum1,
        },
        beatPrices: {
          beat5m,
          beat15m,
        },
        endTime: market5m.endTime,
        timestamp: Date.now(),
      };
    }

    if (sum2 < this.config.arbThreshold) {
      logInfo(
        `Case C arbitrage detected (option 2): sum=${sum2.toFixed(4)} < threshold=${this.config.arbThreshold}`,
      );
      return {
        exists: true,
        case: "C",
        direction: {
          upMarket: "15m",
          downMarket: "5m",
        },
        prices: {
          upPrice: market15m.upPrice,
          downPrice: market5m.downPrice,
          sumPrice: sum2,
        },
        beatPrices: {
          beat5m,
          beat15m,
        },
        endTime: market5m.endTime,
        timestamp: Date.now(),
      };
    }

    // No valid arbitrage
    return {
      exists: false,
      case: "C",
      direction: null,
      prices: {
        upPrice: market5m.upPrice,
        downPrice: market15m.downPrice,
        sumPrice: sum1,
      },
      beatPrices: {
        beat5m,
        beat15m,
      },
      endTime: market5m.endTime,
      timestamp: Date.now(),
      reason: `Both sums (${sum1.toFixed(4)}, ${sum2.toFixed(4)}) >= threshold ${this.config.arbThreshold}`,
    };
  }

  /**
   * Determine order type based on arbitrage strength
   * Strong arbitrage: use market orders
   * Near threshold: use aggressive limit orders
   */
  getOrderType(opportunity: ArbitrageOpportunity): "market" | "limit" {
    if (!opportunity.exists || !opportunity.prices) {
      return "limit";
    }

    const strongThreshold = this.config.arbThreshold - this.config.slippageBuffer;
    if (opportunity.prices.sumPrice < strongThreshold) {
      return "market";
    }

    return "limit";
  }

  /**
   * Calculate limit price with allowed slippage
   */
  calculateLimitPrice(executablePrice: number, opportunity: ArbitrageOpportunity): number {
    const slippage = this.config.maxSlippage;
    return executablePrice * (1 + slippage);
  }
}
