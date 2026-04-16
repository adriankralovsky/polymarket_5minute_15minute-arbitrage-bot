/**
 * Polymarket API client for fetching market data and beat prices
 */

import { retry } from "../utils/retry";
import { logError, logDebug, logWarn, logInfo } from "../utils/logger";

const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";
const CLOB_PRICE_URL = "https://clob.polymarket.com/price";
const CLOB_BOOK_URL = "https://clob.polymarket.com/book";
const BINANCE_PRICE_URL = "https://api.binance.com/api/v3/ticker/price";

const BTC_5M_SLUG_PREFIX = "btc-updown-5m-";
const BTC_15M_SLUG_PREFIX = "btc-updown-15m-";

export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  endDate: string;
  startDate?: string;
  clobTokenIds: string;
  outcomes?: string;
  active?: boolean;
  closed?: boolean;
  // Beat price is stored as lowerBound or upperBound in Gamma API
  lowerBound?: number | string;
  upperBound?: number | string;
  xAxisValue?: number | string;
  yAxisValue?: number | string;
  [k: string]: unknown;
}

export interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  subtitle?: string;
  startDate: string;
  endDate: string;
  creationDate?: string;
  active?: boolean;
  closed?: boolean;
  /** Polymarket event-level metadata — contains priceToBeat and finalPrice (only on closed/resolved markets) */
  eventMetadata?: { priceToBeat?: number | string; finalPrice?: number | string; [k: string]: unknown };
  markets: Array<GammaMarket & {
    eventStartTime?: string;
    startDate?: string;
    eventMetadata?: { priceToBeat?: number | string; [k: string]: unknown };
  }>;
  [k: string]: unknown;
}

export interface MarketTokens {
  upTokenId: string;
  downTokenId: string;
}

export interface TokenPrice {
  price: string | null;
  timestamp: number;
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
  market?: string;
  asset_id?: string;
}

export class PolymarketClient {
  /**
   * Fetch JSON from URL with retry logic
   */
  private async fetchJson<T>(url: string): Promise<T> {
    return retry(
      async () => {
        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": "BTC5-15ArbBot/1.0",
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return response.json() as Promise<T>;
      },
      {
        maxAttempts: 3,
        delaysMs: [0, 1000, 2000],
      },
    );
  }

  /**
   * Get current 5-minute window timestamp
   */
  getCurrent5mWindowTs(): number {
    const WINDOW_SECONDS = 5 * 60;
    return Math.floor(Date.now() / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS;
  }

  /**
   * Get current 15-minute window timestamp
   */
  getCurrent15mWindowTs(): number {
    const WINDOW_SECONDS = 15 * 60;
    return Math.floor(Date.now() / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS;
  }

  /**
   * Get aligned 15m window for a 5m window (every 3rd 5m window aligns)
   */
  getAligned15mWindow(window5mTs: number): number {
    const WINDOW_5M_SECONDS = 5 * 60;
    const WINDOW_15M_SECONDS = 15 * 60;
    // Find the 15m window that contains this 5m window
    return Math.floor(window5mTs / WINDOW_15M_SECONDS) * WINDOW_15M_SECONDS;
  }

  /**
   * Check if 5m and 15m windows end at the same time
   */
  areMarketsAligned(window5mTs: number, window15mTs: number): boolean {
    const WINDOW_5M_SECONDS = 5 * 60;
    const WINDOW_15M_SECONDS = 15 * 60;
    const end5m = window5mTs + WINDOW_5M_SECONDS;
    const end15m = window15mTs + WINDOW_15M_SECONDS;
    return end5m === end15m;
  }

  /**
   * Fetch BTC 5m event by slug (window timestamp)
   */
  async getBtc5mEventBySlugTs(slugTs: number): Promise<GammaEvent | null> {
    const slug = `${BTC_5M_SLUG_PREFIX}${slugTs}`;
    const url = `${GAMMA_EVENTS_URL}?slug=${encodeURIComponent(slug)}`;
    try {
      const data = await this.fetchJson<GammaEvent[]>(url);
      if (Array.isArray(data) && data.length > 0) {
        return data[0];
      }
      return null;
    } catch (error) {
      logError("Failed to fetch BTC 5m event:", error);
      return null;
    }
  }

  /**
   * Fetch BTC 15m event by slug (window timestamp)
   */
  async getBtc15mEventBySlugTs(slugTs: number): Promise<GammaEvent | null> {
    const slug = `${BTC_15M_SLUG_PREFIX}${slugTs}`;
    const url = `${GAMMA_EVENTS_URL}?slug=${encodeURIComponent(slug)}`;
    try {
      const data = await this.fetchJson<GammaEvent[]>(url);
      if (Array.isArray(data) && data.length > 0) {
        return data[0];
      }
      return null;
    } catch (error) {
      logError("Failed to fetch BTC 15m event:", error);
      return null;
    }
  }

  /**
   * Get market token IDs from event
   */
  getMarketTokens(event: GammaEvent): MarketTokens | null {
    const markets = event.markets || [];
    if (markets.length === 0) return null;

    const m = markets[0];
    const raw = m.clobTokenIds;
    if (!raw) return null;

    try {
      const ids = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(ids) && ids.length >= 2) {
        return {
          upTokenId: ids[0],
          downTokenId: ids[1],
        };
    }
    } catch (error) {
      logError("Failed to parse token IDs:", error);
    }
    return null;
  }

  /**
   * Get token price from CLOB
   */
  async getTokenPrice(tokenId: string, side: "buy" | "sell" = "buy"): Promise<TokenPrice | null> {
    const url = `${CLOB_PRICE_URL}?token_id=${tokenId}&side=${side}`;
    try {
      const data = await this.fetchJson<{ price?: string; error?: string }>(url);
      if (data.error) {
        logWarn("CLOB price error:", data.error);
        return null;
      }
      return {
        price: data.price || null,
        timestamp: Date.now(),
      };
    } catch (error) {
      logError("Failed to get token price:", error);
      return null;
    }
  }

  /**
   * Get orderbook for a token
   */
  async getOrderBook(tokenId: string): Promise<OrderBook | null> {
    const url = `${CLOB_BOOK_URL}?token_id=${tokenId}`;
    try {
      const data = await this.fetchJson<OrderBook>(url);
      if ("error" in data) {
        logWarn("CLOB orderbook error:", (data as { error: string }).error);
        return null;
      }
      return {
        ...data,
        timestamp: Date.now(),
      };
    } catch (error) {
      logError("Failed to get orderbook:", error);
      return null;
    }
  }

  /**
   * Extract market start timestamp from event
   * Beat price = Chainlink BTC/USD price at market start time
   * For 15m markets, we need to check all markets in the event
   */
  getMarketStartTimestamp(event: GammaEvent): number | null {
    // Check all markets, not just the first one (15m events might have multiple markets)
    const markets = event.markets || [];
    
    for (const market of markets) {
      // Try eventStartTime first (most accurate)
      if (market?.eventStartTime) {
        const ts = Math.floor(new Date(market.eventStartTime).getTime() / 1000);
        logDebug(`Found market start timestamp from eventStartTime: ${ts} (${new Date(ts * 1000).toISOString()})`);
        return ts;
      }
      
      // Try startDate
      if (market?.startDate) {
        const ts = Math.floor(new Date(market.startDate).getTime() / 1000);
        logDebug(`Found market start timestamp from startDate: ${ts} (${new Date(ts * 1000).toISOString()})`);
        return ts;
      }
    }
    
    // Fallback to event-level dates
    if (event.startDate) {
      const ts = Math.floor(new Date(event.startDate).getTime() / 1000);
      logDebug(`Found market start timestamp from event.startDate: ${ts} (${new Date(ts * 1000).toISOString()})`);
      return ts;
    }
    
    if (event.creationDate) {
      const ts = Math.floor(new Date(event.creationDate).getTime() / 1000);
      logDebug(`Found market start timestamp from event.creationDate: ${ts} (${new Date(ts * 1000).toISOString()})`);
      return ts;
    }
    
    logWarn(`Could not find market start timestamp for event ${event.slug}`);
    logWarn(`Event has ${markets.length} markets`);
    if (markets.length > 0) {
      logWarn(`First market keys: ${Object.keys(markets[0] || {}).join(", ")}`);
    }
    
    return null;
  }

  /**
   * Extract the Chainlink beat price from a Gamma API market object.
   *
   * Polymarket stores the Chainlink BTC/USD strike price in one of several locations
   * depending on when the event was created. Fields tried in order:
   *   1. market.eventMetadata.priceToBeat  (current format as of 2026)
   *   2. lowerBound → upperBound → xAxisValue  (legacy fields)
   *
   * Any value outside [10 000, 10 000 000] is rejected as implausible for BTC/USD.
   */
  private extractBeatPrice(market: GammaMarket & { eventMetadata?: { priceToBeat?: number | string } }): number | null {
    // 1. Check market-level eventMetadata.priceToBeat (current API format)
    const metaRaw = market.eventMetadata?.priceToBeat;
    if (metaRaw !== undefined && metaRaw !== null) {
      const metaValue = typeof metaRaw === "string" ? parseFloat(metaRaw) : (metaRaw as number);
      if (!isNaN(metaValue) && metaValue >= 10_000 && metaValue <= 10_000_000) {
        logDebug(`Beat price from eventMetadata.priceToBeat: $${metaValue} (market: ${market.slug})`);
        return metaValue;
      }
    }

    // 2. Legacy fields: lowerBound → upperBound → xAxisValue
    const fields = ["lowerBound", "upperBound", "xAxisValue"] as const;
    for (const field of fields) {
      const raw = market[field];
      if (raw === undefined || raw === null) continue;
      const value = typeof raw === "string" ? parseFloat(raw) : (raw as number);
      if (isNaN(value)) continue;
      if (value < 10_000 || value > 10_000_000) {
        logWarn(
          `Beat price candidate ${value} from field "${field}" on market ${market.slug} ` +
          `is outside plausible BTC/USD range [10 000, 10 000 000] — ignoring`,
        );
        continue;
      }
      logDebug(`Beat price from ${field}: $${value} (market: ${market.slug})`);
      return value;
    }
    logWarn(`No beat price found in Gamma API data for market ${market.slug}`);
    return null;
  }

  /**
   * Get beat price from a Gamma API event.
   *
   * Lookup order (most to least authoritative):
   *   1. event.eventMetadata.priceToBeat  — top-level event field (current API)
   *   2. Per-sub-market extractBeatPrice() — checks market.eventMetadata.priceToBeat
   *      then legacy lowerBound / upperBound / xAxisValue fields.
   *
   * No external HTTP calls are made — the Gamma API data already contains the
   * authoritative Chainlink price that Polymarket uses for settlement.
   *
   * Returns null if no field carries a plausible beat price; callers must treat
   * null as a hard abort — tracking cannot proceed without an accurate strike price.
   */
  getBeatPriceFromEvent(event: GammaEvent): number | null {
    // 1. Check top-level event eventMetadata.priceToBeat (current API format)
    const topMetaRaw = event.eventMetadata?.priceToBeat;
    if (topMetaRaw !== undefined && topMetaRaw !== null) {
      const topMetaValue = typeof topMetaRaw === "string" ? parseFloat(topMetaRaw) : (topMetaRaw as number);
      if (!isNaN(topMetaValue) && topMetaValue >= 10_000 && topMetaValue <= 10_000_000) {
        logDebug(`Beat price from event.eventMetadata.priceToBeat: $${topMetaValue} (event: ${event.slug})`);
        return topMetaValue;
      }
    }

    // 2. Fall back to per-sub-market search
    const markets = event.markets ?? [];
    if (markets.length === 0) {
      logWarn(`No markets found in Gamma API event ${event.slug} — cannot extract beat price`);
      return null;
    }
    for (const market of markets) {
      const value = this.extractBeatPrice(market);
      if (value !== null) return value;
    }
    logWarn(`No valid beat price found in any sub-market of event ${event.slug}`);
    return null;
  }

  /**
   * Fetch live BTC/USD price from Binance as a fallback.
   *
   * Used when Gamma API eventMetadata is not yet populated (active markets).
   * Binance BTCUSDT is highly liquid and typically within $50-100 of the
   * Chainlink BTC/USD feed that Polymarket uses for settlement.
   *
   * For the arbitrage bot this is acceptable: what matters is the *relative*
   * difference between 5m and 15m beat prices, not the absolute accuracy.
   * Both markets' fallback prices come from the same source at the same time,
   * so any bias cancels out.
   */
  async fetchBtcUsdFromBinance(): Promise<number | null> {
    const url = `${BINANCE_PRICE_URL}?symbol=BTCUSDT`;
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "BTC5-15ArbBot/1.0" },
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });
      if (!response.ok) {
        logWarn(`Binance API returned HTTP ${response.status}`);
        return null;
      }
      const data = await response.json() as { symbol?: string; price?: string };
      if (data.price) {
        const price = parseFloat(data.price);
        if (!isNaN(price) && price >= 10_000 && price <= 10_000_000) {
          return price;
        }
      }
      logWarn(`Binance API returned unexpected data: ${JSON.stringify(data)}`);
      return null;
    } catch (error) {
      logError("Failed to fetch BTC price from Binance:", error);
      return null;
    }
  }

  /**
   * Try to get beat price from the PREVIOUS window's resolved event.
   *
   * Polymarket populates `eventMetadata.finalPrice` on closed markets — this is
   * the Chainlink BTC/USD price at the END of that window, which equals the
   * START price (i.e. priceToBeat) of the CURRENT window.
   *
   * @param marketType "5m" or "15m"
   * @param currentWindowTs The current window's start timestamp
   * @returns The previous window's finalPrice, or null if unavailable
   */
  async getBeatPriceFromPreviousWindow(
    marketType: "5m" | "15m",
    currentWindowTs: number,
  ): Promise<{ value: number; source: string } | null> {
    const windowSeconds = marketType === "5m" ? 5 * 60 : 15 * 60;
    const prevWindowTs = currentWindowTs - windowSeconds;
    const prefix = marketType === "5m" ? BTC_5M_SLUG_PREFIX : BTC_15M_SLUG_PREFIX;
    const slug = `${prefix}${prevWindowTs}`;
    const url = `${GAMMA_EVENTS_URL}?slug=${encodeURIComponent(slug)}`;

    try {
      const data = await this.fetchJson<GammaEvent[]>(url);
      if (!Array.isArray(data) || data.length === 0) {
        logDebug(`Previous ${marketType} window event not found (slug: ${slug})`);
        return null;
      }
      const prevEvent = data[0];

      // Check finalPrice on the previous (now-resolved) event
      const finalRaw = prevEvent.eventMetadata?.finalPrice;
      if (finalRaw !== undefined && finalRaw !== null) {
        const finalValue = typeof finalRaw === "string" ? parseFloat(finalRaw) : (finalRaw as number);
        if (!isNaN(finalValue) && finalValue >= 10_000 && finalValue <= 10_000_000) {
          logDebug(
            `Beat price from previous ${marketType} window finalPrice: $${finalValue} ` +
            `(prev slug: ${slug})`,
          );
          return { value: finalValue, source: "gamma-api-prev-finalPrice" };
        }
      }

      // Also try priceToBeat on the previous event as a secondary check
      const ptbRaw = prevEvent.eventMetadata?.priceToBeat;
      if (ptbRaw !== undefined && ptbRaw !== null) {
        // The previous window's priceToBeat is NOT the current window's beat price,
        // but we log it for debugging context.
        logDebug(
          `Previous ${marketType} window has priceToBeat but not finalPrice (slug: ${slug})`,
        );
      }

      return null;
    } catch (error) {
      logDebug(`Failed to fetch previous ${marketType} window event: ${error}`);
      return null;
    }
  }

  /**
   * Get beat price with multi-source fallback.
   *
   * Polymarket only populates `eventMetadata.priceToBeat` AFTER a market resolves.
   * Active markets have no eventMetadata at all. This method implements a 3-tier
   * fallback to ensure the bot can always obtain a beat price:
   *
   *   1. Gamma API `eventMetadata.priceToBeat` — authoritative Chainlink price
   *      (only available on closed/resolved markets)
   *   2. Previous window's `eventMetadata.finalPrice` — the Chainlink price at
   *      the end of the prior window = start of the current window
   *   3. Live Binance BTC/USDT — immediate fallback, typically within $50-100
   *      of the Chainlink feed
   *
   * @returns { value, source } or null if all sources fail
   */
  async getBeatPriceWithFallbacks(
    event: GammaEvent,
    marketType: "5m" | "15m",
    windowTs: number,
  ): Promise<{ value: number; source: string } | null> {
    // 1. Try Gamma API eventMetadata.priceToBeat (only on closed markets)
    const gammaPrice = this.getBeatPriceFromEvent(event);
    if (gammaPrice !== null) {
      logInfo(
        `✅ Beat price for ${marketType} from Gamma API: $${gammaPrice.toFixed(2)} (event: ${event.slug})`,
      );
      return { value: gammaPrice, source: "gamma-api" };
    }

    // 2. Try previous window's finalPrice (Chainlink price at previous window's end = current start)
    logDebug(
      `${marketType} market ${event.slug} has no eventMetadata.priceToBeat (market is active/unresolved). ` +
      `Trying previous window...`,
    );
    const prevPrice = await this.getBeatPriceFromPreviousWindow(marketType, windowTs);
    if (prevPrice !== null) {
      logInfo(
        `✅ Beat price for ${marketType} from previous window finalPrice: $${prevPrice.value.toFixed(2)} ` +
        `(event: ${event.slug})`,
      );
      return prevPrice;
    }

    // 3. Last resort: live Binance BTC/USDT
    logDebug(
      `${marketType} previous window also unavailable. Falling back to Binance BTC/USDT...`,
    );
    const binancePrice = await this.fetchBtcUsdFromBinance();
    if (binancePrice !== null) {
      logInfo(
        `✅ Beat price for ${marketType} from Binance fallback: $${binancePrice.toFixed(2)} ` +
        `(event: ${event.slug}) ⚠️ May diverge from Chainlink by $50-200`,
      );
      return { value: binancePrice, source: "binance-fallback" };
    }

    logError(
      `❌ All beat price sources failed for ${marketType} market (event: ${event.slug}). ` +
      `Cannot trade without strike price.`,
    );
    return null;
  }

  /**
   * Fetch the final settlement BTC/USD price for a market that has just resolved.
   *
   * Polymarket populates `eventMetadata.finalPrice` on the Gamma API event once
   * the Chainlink oracle has settled — this is the authoritative price used for
   * UP/DOWN resolution. The slug is reconstructed from the market's endTime,
   * which equals the start timestamp of the NEXT window.
   *
   * Tries both the 5m and 15m slugs (either could match depending on which market
   * type we're resolving). Falls back to the live Binance price if the oracle
   * hasn't propagated yet (typically within ~60 seconds of market close).
   *
   * @param endTimeUnix Unix timestamp (seconds) of the market's endTime
   * @returns Final BTC/USD price, or null if unavailable
   */
  async getFinalBtcPrice(endTimeUnix: number): Promise<number | null> {
    // The endTime of the current window = startTs of the next window = the slug
    // used by Polymarket for the next event. But we want the CURRENT event which
    // has this endTime. Its slug is startTs = endTime - windowLength.
    // Since we don't know the window length from here, try both 5m and 15m slugs
    // whose end times match endTimeUnix.
    const slug5m  = `${BTC_5M_SLUG_PREFIX}${endTimeUnix  - 5  * 60}`;
    const slug15m = `${BTC_15M_SLUG_PREFIX}${endTimeUnix - 15 * 60}`;

    for (const slug of [slug5m, slug15m]) {
      try {
        const url = `${GAMMA_EVENTS_URL}?slug=${encodeURIComponent(slug)}`;
        const data = await this.fetchJson<GammaEvent[]>(url);
        if (!Array.isArray(data) || data.length === 0) continue;

        const event = data[0];
        const finalRaw = event.eventMetadata?.finalPrice;
        if (finalRaw !== undefined && finalRaw !== null) {
          const finalValue = typeof finalRaw === "string" ? parseFloat(finalRaw) : (finalRaw as number);
          if (!isNaN(finalValue) && finalValue >= 10_000 && finalValue <= 10_000_000) {
            logInfo(`Final BTC price from Gamma API (slug: ${slug}): $${finalValue.toFixed(2)}`);
            return finalValue;
          }
        }
      } catch (error) {
        logDebug(`Failed to fetch final price for slug ${slug}: ${error}`);
      }
    }

    // Oracle hasn't settled yet — fall back to live Binance price.
    logWarn(`Gamma API finalPrice not yet available for endTime ${endTimeUnix} — using Binance fallback`);
    return this.fetchBtcUsdFromBinance();
  }

  /**
   * Get best executable price from orderbook (best ask for buying)
   */
  getBestExecutablePrice(orderbook: OrderBook | null): number | null {
    if (!orderbook || !orderbook.asks || orderbook.asks.length === 0) {
      return null;
    }
    return parseFloat(orderbook.asks[0].price);
  }

  /**
   * Calculate liquidity from orderbook (sum of ask sizes up to a certain depth)
   */
  calculateLiquidity(orderbook: OrderBook | null, depth = 5): number {
    if (!orderbook || !orderbook.asks || orderbook.asks.length === 0) {
      return 0;
    }
    return orderbook.asks
      .slice(0, depth)
      .reduce((sum, level) => sum + parseFloat(level.size), 0);
  }
}
