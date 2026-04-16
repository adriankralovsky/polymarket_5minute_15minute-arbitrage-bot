/**
 * Arbitrage detection engine with beat price comparison logic
 * Implements Cases A, B, and C from specification
 */

import type { MarketData, ArbitrageOpportunity, MarketType, PriceSnapshot } from "../types";
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
   * Returns true if the market's UP or DOWN price range over the recent history
   * window exceeds config.maxPriceVolatility.
   *
   * A large range means the market is moving too fast to enter safely — the
   * price we detected may already be stale by the time the order reaches the
   * matching engine. Trades are skipped when this returns true.
   *
   * The filter is dormant until at least config.minHistoryForFilter snapshots
   * have accumulated, preventing false positives on bot startup.
   */
  isMarketTooVolatile(market: MarketData): boolean {
    const history = market.priceHistory;
    if (history.length < this.config.minHistoryForFilter) {
      return false;
    }

    const upPrices = history
      .map((s: PriceSnapshot) => s.upPrice)
      .filter((p): p is number => p !== null && p > 0);
    const downPrices = history
      .map((s: PriceSnapshot) => s.downPrice)
      .filter((p): p is number => p !== null && p > 0);

    if (
      upPrices.length < this.config.minHistoryForFilter ||
      downPrices.length < this.config.minHistoryForFilter
    ) {
      return false;
    }

    const upRange   = Math.max(...upPrices)   - Math.min(...upPrices);
    const downRange = Math.max(...downPrices) - Math.min(...downPrices);

    if (upRange > this.config.maxPriceVolatility) {
      logWarn(
        `Volatility: UP range ${upRange.toFixed(4)} > threshold ${this.config.maxPriceVolatility} ` +
        `on market ${market.marketId}`,
      );
      return true;
    }
    if (downRange > this.config.maxPriceVolatility) {
      logWarn(
        `Volatility: DOWN range ${downRange.toFixed(4)} > threshold ${this.config.maxPriceVolatility} ` +
        `on market ${market.marketId}`,
      );
      return true;
    }
    return false;
  }

  /**
   * Estimates the slippage fraction for one leg based on recent tick velocity.
   *
   * Computes the average absolute change between consecutive price snapshots,
   * expresses it as a fraction of current price, then adds a 50% safety buffer.
   * Result is clamped between config.maxSlippage (floor) and 2× that (ceiling).
   *
   * This replaces the flat config.maxSlippage value when building order prices,
   * so fast-moving markets get a wider limit and slow markets stay tight.
   */
  estimateSlippageFromHistory(market: MarketData, side: "up" | "down"): number {
    const history = market.priceHistory;

    if (history.length < 2) {
      return this.config.maxSlippage;
    }

    const prices = history
      .map((s: PriceSnapshot) => (side === "up" ? s.upPrice : s.downPrice))
      .filter((p): p is number => p !== null && p > 0);

    if (prices.length < 2) {
      return this.config.maxSlippage;
    }

    // Average absolute change between consecutive snapshots
    let totalChange = 0;
    for (let i = 1; i < prices.length; i++) {
      totalChange += Math.abs(prices[i] - prices[i - 1]);
    }
    const avgTickChange = totalChange / (prices.length - 1);

    const currentPrice = prices[prices.length - 1];
    if (currentPrice <= 0) return this.config.maxSlippage;

    // Convert to a fraction, add 50% buffer, clamp to [maxSlippage, 2×maxSlippage]
    const estimated = (avgTickChange / currentPrice) * 1.5;
    return Math.max(
      this.config.maxSlippage,
      Math.min(estimated, this.config.maxSlippage * 2),
    );
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

}
