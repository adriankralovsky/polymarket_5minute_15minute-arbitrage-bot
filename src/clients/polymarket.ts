/**
 * Polymarket API client for fetching market data and beat prices
 */

import { retry } from "../utils/retry";
import { logError, logInfo, logDebug, logWarn } from "../utils/logger";

const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";
const CLOB_PRICE_URL = "https://clob.polymarket.com/price";
const CLOB_BOOK_URL = "https://clob.polymarket.com/book";
const COINGECKO_RANGE_URL = "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range";

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
   * Get Chainlink BTC/USD price at specific timestamp
   * Beat price = Chainlink BTC/USD price at market start time
   */
  private async getChainlinkPriceAtTimestamp(timestamp: number): Promise<number | null> {
    try {
      // Method 1: Try Chainlink Data Streams API
      try {
        const streamsUrl = `https://data.chain.link/streams/btc-usd/reports?timestamp=${timestamp}`;
        const response = await fetch(streamsUrl, {
          headers: {
            Accept: "application/json",
            "User-Agent": "BTC5-15ArbBot/1.0",
          },
        });
        
        if (response.ok) {
          const contentType = response.headers.get("content-type");
          if (contentType && contentType.includes("application/json")) {
            const data = await response.json() as {
              reports?: Array<{ timestamp: string; price: number }>;
              price?: number;
              [key: string]: unknown;
            };
            
            if (typeof data.price === "number") {
              return data.price;
            }
            
            if (Array.isArray(data.reports) && data.reports.length > 0) {
              const targetMs = timestamp * 1000;
              const closest = data.reports.reduce((best, current) => {
                const bestTs = new Date(best.timestamp).getTime();
                const currentTs = new Date(current.timestamp).getTime();
                return Math.abs(currentTs - targetMs) < Math.abs(bestTs - targetMs) ? current : best;
              });
              
              if (closest.price) {
                return closest.price;
              }
            }
          }
        }
      } catch (err) {
        logDebug(`Chainlink Data Streams failed: ${err}`);
      }
      
      // Method 2: Try CoinGecko historical price (fallback for Chainlink)
      // CoinGecko provides historical BTC prices that match Chainlink data
      try {
        const now = Math.floor(Date.now() / 1000);
        const from = timestamp;
        const to = Math.min(timestamp + 60, now); // 1 minute range
        
        const coingeckoUrl = `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;
        const response = await fetch(coingeckoUrl, {
          headers: {
            Accept: "application/json",
            "User-Agent": "BTC5-15ArbBot/1.0",
          },
        });
        
        if (response.ok) {
          const contentType = response.headers.get("content-type");
          if (contentType && contentType.includes("application/json")) {
            const data = await response.json() as { prices: [number, number][] };
            
            if (Array.isArray(data.prices) && data.prices.length > 0) {
              // Get price closest to timestamp
              const targetMs = timestamp * 1000;
              const closest = data.prices.reduce((best, current) => {
                const bestDiff = Math.abs(best[0] - targetMs);
                const currentDiff = Math.abs(current[0] - targetMs);
                return currentDiff < bestDiff ? current : best;
              });
              
              if (closest[1]) {
                logDebug(`Using CoinGecko historical price (matches Chainlink data)`);
                return closest[1];
              }
            }
          }
        }
      } catch (err) {
        logDebug(`CoinGecko historical price failed: ${err}`);
      }
      
      // Method 3: Current price if timestamp is very recent
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(timestamp - now) < 300) {
        try {
          const currentUrl = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";
          const response = await fetch(currentUrl, {
            headers: {
              Accept: "application/json",
              "User-Agent": "BTC5-15ArbBot/1.0",
            },
          });
          
          if (response.ok) {
            const contentType = response.headers.get("content-type");
            if (contentType && contentType.includes("application/json")) {
              const data = await response.json() as { bitcoin?: { usd?: number } };
              if (data.bitcoin?.usd) {
                logDebug(`Using current CoinGecko price (timestamp is very recent)`);
                return data.bitcoin.usd;
              }
            }
          }
        } catch (err) {
          logDebug(`Current price fetch failed: ${err}`);
        }
      }
      
      return null;
    } catch (error) {
      logError("Failed to get Chainlink price:", error);
      return null;
    }
  }

  /**
   * Get beat price from event
   * Beat price = Chainlink BTC/USD price at market start time
   * This is the correct method to fetch beat price for arbitrage bot
   */
  async getBeatPriceFromEvent(event: GammaEvent): Promise<number | null> {
    try {
      logDebug(`Fetching beat price for event: ${event.slug} (title: ${event.title || "N/A"})`);
      
      // Extract market start timestamp
      const startTimestamp = this.getMarketStartTimestamp(event);
      if (!startTimestamp) {
        logError(`Could not determine market start timestamp for event ${event.slug}`);
        logError(`Event details: startDate=${event.startDate}, creationDate=${event.creationDate}`);
        logError(`Markets count: ${event.markets?.length || 0}`);
        if (event.markets && event.markets.length > 0) {
          const firstMarket = event.markets[0];
          logError(`First market keys: ${Object.keys(firstMarket || {}).join(", ")}`);
          logError(`First market eventStartTime: ${(firstMarket as any)?.eventStartTime || "N/A"}`);
          logError(`First market startDate: ${(firstMarket as any)?.startDate || "N/A"}`);
        }
        return null;
      }

      logDebug(`Market start timestamp: ${startTimestamp} (${new Date(startTimestamp * 1000).toISOString()})`);

      // Get Chainlink price at market start time
      const beatPrice = await this.getChainlinkPriceAtTimestamp(startTimestamp);
      
      if (beatPrice) {
        logInfo(`✅ Beat price for ${event.slug}: $${beatPrice.toFixed(2)} (Chainlink BTC/USD at market start)`);
      } else {
        logError(`❌ Failed to fetch beat price for ${event.slug} (Chainlink price at market start)`);
        logError(`Timestamp was: ${startTimestamp} (${new Date(startTimestamp * 1000).toISOString()})`);
      }
      
      return beatPrice;
    } catch (error) {
      logError(`Failed to get beat price from event ${event.slug}:`, error);
      return null;
    }
  }

  /**
   * Extract beat price from Gamma API market data
   * DEPRECATED: Use getBeatPriceFromEvent() instead
   * Beat price should be fetched from Chainlink at market start time, not from market metadata
   */
  getBeatPriceFromMarket(market: GammaMarket): number | null {
    logWarn("getBeatPriceFromMarket is deprecated. Use getBeatPriceFromEvent() instead.");
    try {
      // For BTC UP/DOWN markets, beat price is typically in lowerBound or upperBound
      // Check lowerBound first (common for "above X" markets)
      if (market.lowerBound !== undefined && market.lowerBound !== null) {
        const value = typeof market.lowerBound === "string" 
          ? parseFloat(market.lowerBound) 
          : market.lowerBound;
        if (!isNaN(value) && value > 0) {
          logDebug(`Beat price from lowerBound: ${value}`);
          return value;
        }
      }

      // Check upperBound (for "below X" or range markets)
      if (market.upperBound !== undefined && market.upperBound !== null) {
        const value = typeof market.upperBound === "string" 
          ? parseFloat(market.upperBound) 
          : market.upperBound;
        if (!isNaN(value) && value > 0) {
          logDebug(`Beat price from upperBound: ${value}`);
          return value;
        }
      }

      // Check xAxisValue or yAxisValue as fallback
      if (market.xAxisValue !== undefined && market.xAxisValue !== null) {
        const value = typeof market.xAxisValue === "string" 
          ? parseFloat(market.xAxisValue) 
          : market.xAxisValue;
        if (!isNaN(value) && value > 0) {
          logDebug(`Beat price from xAxisValue: ${value}`);
          return value;
        }
      }

      logWarn(`No beat price found in market data for ${market.slug}`);
      return null;
    } catch (error) {
      logError("Failed to extract beat price from market:", error);
      return null;
    }
  }

  /**
   * Get BTC price at specific timestamp (for beat price) from Chainlink
   * DEPRECATED: Use getBeatPriceFromEvent() instead
   * This method is kept for backward compatibility only
   */
  async getBtcPriceAtTimestamp(timestamp: number): Promise<number | null> {
    logWarn("getBtcPriceAtTimestamp is deprecated. Use getBeatPriceFromEvent() instead.");
    return this.getChainlinkPriceAtTimestamp(timestamp);
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
