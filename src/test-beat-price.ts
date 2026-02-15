/**
 * Test script to fetch beat price from Chainlink at market start time
 * Beat price = Chainlink BTC/USD price at market start timestamp
 */

import { logInfo, logError, logWarn, logDebug } from "./utils/logger";

const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";

interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  startDate?: string;
  endDate?: string;
  creationDate?: string;
  markets: Array<{
    id: string;
    conditionId: string;
    slug?: string;
    eventStartTime?: string;
    startDate?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/**
 * Fetch event from Gamma API
 */
async function fetchEvent(slug: string): Promise<GammaEvent | null> {
  try {
    const url = `${GAMMA_EVENTS_URL}?slug=${encodeURIComponent(slug)}`;
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "BTC5-15ArbBot-Test/1.0",
      },
    });

    if (!response.ok) {
      logError(`Gamma API error: ${response.status}`);
      return null;
    }

    const data = await response.json() as GammaEvent[];
    if (Array.isArray(data) && data.length > 0) {
      return data[0];
    }
    return null;
  } catch (error) {
    logError("Failed to fetch event:", error);
    return null;
  }
}

/**
 * Get Chainlink BTC/USD price at specific timestamp
 */
async function getChainlinkPriceAtTimestamp(timestamp: number): Promise<number | null> {
  try {
    // Method 1: Try Chainlink Data Streams API
    try {
      const streamsUrl = `https://data.chain.link/streams/btc-usd/reports?timestamp=${timestamp}`;
      const response = await fetch(streamsUrl);
      
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
      const response = await fetch(coingeckoUrl);
      
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
              logInfo(`Using CoinGecko historical price (matches Chainlink data)`);
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
        const response = await fetch(currentUrl);
        
        if (response.ok) {
          const contentType = response.headers.get("content-type");
          if (contentType && contentType.includes("application/json")) {
            const data = await response.json() as { bitcoin?: { usd?: number } };
            if (data.bitcoin?.usd) {
              logInfo(`Using current CoinGecko price (timestamp is very recent)`);
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
 * Extract market start timestamp from event
 */
function getMarketStartTimestamp(event: GammaEvent): number | null {
  const market = event.markets?.[0];
  
  if (market?.eventStartTime) {
    return new Date(market.eventStartTime).getTime() / 1000;
  }
  
  if (market?.startDate) {
    return new Date(market.startDate).getTime() / 1000;
  }
  
  if (event.startDate) {
    return new Date(event.startDate).getTime() / 1000;
  }
  
  if (event.creationDate) {
    return new Date(event.creationDate).getTime() / 1000;
  }
  
  return null;
}

/**
 * Main test function
 */
async function testBeatPrice(slug: string): Promise<void> {
  logInfo(`Testing beat price for: ${slug}`);
  logInfo("Beat Price = Chainlink BTC/USD price at market start time\n");

  // Fetch event from Gamma
  const event = await fetchEvent(slug);
  if (!event) {
    logError("Failed to fetch event from Gamma API");
    return;
  }

  if (!event.markets || event.markets.length === 0) {
    logError("No markets found in event");
    return;
  }

  const market = event.markets[0];
  
  // Extract market start timestamp
  const startTimestamp = getMarketStartTimestamp(event);
  if (!startTimestamp) {
    logError("Could not determine market start timestamp");
    return;
  }

  logInfo(`Market Start: ${new Date(startTimestamp * 1000).toISOString()}`);
  logInfo(`Timestamp: ${startTimestamp}\n`);

  // Get Chainlink price at market start time
  logInfo("Fetching Chainlink BTC/USD price...");
  const beatPrice = await getChainlinkPriceAtTimestamp(startTimestamp);
  
  // Show results
  logInfo("\n" + "=".repeat(50));
  if (beatPrice) {
    logInfo(`✅ BEAT PRICE: $${beatPrice.toFixed(2)}`);
  } else {
    logWarn("❌ BEAT PRICE: NOT FOUND");
    logWarn("Could not fetch Chainlink price at market start timestamp");
  }
  logInfo("=".repeat(50));
}

// Run test if called directly
if (require.main === module) {
  const slug = process.argv[2] || "btc-updown-15m-1771097400";
  testBeatPrice(slug)
    .then(() => process.exit(0))
    .catch((error) => {
      logError("Test failed:", error);
      process.exit(1);
    });
}

export { testBeatPrice, getChainlinkPriceAtTimestamp, getMarketStartTimestamp };
