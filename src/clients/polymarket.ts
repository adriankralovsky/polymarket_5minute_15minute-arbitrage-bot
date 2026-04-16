/**
 * Polymarket API client for fetching market data and beat prices
 */

import { retry } from "../utils/retry";
import { logError, logDebug, logWarn } from "../utils/logger";

const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";
const CLOB_PRICE_URL = "https://clob.polymarket.com/price";
const CLOB_BOOK_URL = "https://clob.polymarket.com/book";

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
  markets: Array<GammaMarket & {
    eventStartTime?: string;
    startDate?: string;
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
   * Polymarket stores the Chainlink BTC/USD strike price as `lowerBound` on the
   * market. This is the authoritative settlement value. We must NOT substitute an
   * external oracle (CoinGecko, Chainlink Data Streams) — those can diverge by
   * $50–200 from the value Polymarket actually uses to settle the contract.
   *
   * Fields tried in order: lowerBound → upperBound → xAxisValue.
   * Any value outside [1 000, 10 000 000] is rejected as implausible for BTC/USD.
   */
  private extractBeatPrice(market: GammaMarket): number | null {
    const fields = ["lowerBound", "upperBound", "xAxisValue"] as const;
    for (const field of fields) {
      const raw = market[field];
      if (raw === undefined || raw === null) continue;
      const value = typeof raw === "string" ? parseFloat(raw) : (raw as number);
      if (isNaN(value)) continue;
      if (value < 1_000 || value > 10_000_000) {
        logWarn(
          `Beat price candidate ${value} from field "${field}" on market ${market.slug} ` +
          `is outside plausible BTC/USD range [1 000, 10 000 000] — ignoring`,
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
   * Reads the strike price directly from the first market's `lowerBound` field.
   * No external HTTP calls are made — the Gamma API data already contains the
   * authoritative Chainlink price that Polymarket uses for settlement.
   *
   * Returns null if the field is absent or implausible; callers must treat null
   * as a hard abort — tracking cannot proceed without an accurate strike price.
   */
  getBeatPriceFromEvent(event: GammaEvent): number | null {
    const market = event.markets?.[0];
    if (!market) {
      logWarn(`No markets found in Gamma API event ${event.slug} — cannot extract beat price`);
      return null;
    }
    return this.extractBeatPrice(market);
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
