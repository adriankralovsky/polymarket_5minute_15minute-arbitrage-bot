/**
 * Real-time market data manager with WebSocket feeds
 * Maintains in-memory state cache updated by events
 */

import WebSocket from "ws";
import type { MarketData, PriceSnapshot, MarketType } from "../types";
import { PolymarketClient } from "../clients/polymarket";
import { logInfo, logError, logDebug, logWarn } from "../utils/logger";
import { getConfig } from "../config";
import type { OrderBook, TokenPrice } from "../clients/polymarket";

// WebSocket URL for Polymarket CLOB subscriptions
// According to https://docs.polymarket.com/developers/CLOB/websocket/wss-overview
// The correct WebSocket URL is: wss://ws-subscriptions-clob.polymarket.com/ws/market
// This is MANDATORY for arbitrage bot - real-time data is critical
// Market channel: NO AUTH REQUIRED (see https://docs.polymarket.com/developers/CLOB/websocket/wss-auth)
// Can be overridden via POLYMARKET_WS_URL environment variable
const WSS_URL = process.env.POLYMARKET_WS_URL || "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export interface MarketDataCallbacks {
  onMarketDataUpdate?: (marketType: MarketType, data: MarketData) => void;
  onSyncDetected?: (market5m: MarketData, market15m: MarketData) => void;
  onError?: (error: Error) => void;
}

// WebSocket connection state for each market type
interface WebSocketState {
  ws: WebSocket | null;
  reconnectTimer: NodeJS.Timeout | null;
  pingInterval: NodeJS.Timeout | null;
  pongCheckInterval: NodeJS.Timeout | null;
  lastPongTime: number;
  subscriptions: Set<string>;
  messageHandlers: Map<string, (data: unknown) => void>;
}

export class MarketDataManager {
  private client: PolymarketClient;
  // Separate WebSocket connections: one for 5m market, one for 15m market
  private ws5m: WebSocketState = {
    ws: null,
    reconnectTimer: null,
    pingInterval: null,
    pongCheckInterval: null,
    lastPongTime: 0,
    subscriptions: new Set(),
    messageHandlers: new Map(),
  };
  private ws15m: WebSocketState = {
    ws: null,
    reconnectTimer: null,
    pingInterval: null,
    pongCheckInterval: null,
    lastPongTime: 0,
    subscriptions: new Set(),
    messageHandlers: new Map(),
  };
  private marketCache: Map<string, MarketData> = new Map();
  // Beat price cache: key = market start time (timestamp), value = beat price
  // Beat price is FIXED at market start time (Chainlink BTC/USD price)
  // Once fetched, store it and reuse - only update when new market detected
  private beatPriceCache: Map<number, number> = new Map();
  private callbacks: MarketDataCallbacks;
  private config = getConfig();
  private tableInitialized: boolean = false;
  private market5m: MarketData | null = null;
  private market15m: MarketData | null = null;
  private lastTableUpdate: number = 0; // Throttle table updates
  private readonly TABLE_UPDATE_INTERVAL = 100; // Update table at most every 100ms
  private tableUpdateTimer: NodeJS.Timeout | null = null; // Debounce timer for table updates
  private isWritingTable: boolean = false; // Lock to prevent concurrent writes
  private pendingTableUpdate: boolean = false; // Flag for pending update

  constructor(client: PolymarketClient, callbacks: MarketDataCallbacks) {
    this.client = client;
    this.callbacks = callbacks;
  }

  /**
   * Connect WebSocket for a specific market type (5m or 15m)
   * Each market type has its own separate WebSocket connection
   */
  private connectWebSocketForMarket(marketType: "5m" | "15m"): void {
    const wsState = marketType === "5m" ? this.ws5m : this.ws15m;
    
    // Prevent multiple connections: check if already connected OR connecting
    if (wsState.ws) {
      const state = wsState.ws.readyState;
      if (state === WebSocket.OPEN) {
        logDebug(`${marketType} WebSocket already connected, skipping`);
        return;
      }
      if (state === WebSocket.CONNECTING) {
        logDebug(`${marketType} WebSocket already connecting, skipping`);
        return;
      }
      // If closing or closed, clean up first
      if (state === WebSocket.CLOSING || state === WebSocket.CLOSED) {
        logDebug(`Cleaning up old ${marketType} WebSocket connection`);
        wsState.ws.removeAllListeners();
        wsState.ws = null;
      }
    }

    logInfo(`Connecting ${marketType} market WebSocket: ${WSS_URL}`);
    
    // Create separate WebSocket connection for this market type
    wsState.ws = new WebSocket(WSS_URL, {
      headers: {
        "User-Agent": "BTC5-15ArbBot/1.0",
        "Origin": "https://polymarket.com",
      },
    });

    wsState.ws.on("open", () => {
      logInfo(`${marketType} market WebSocket connected successfully`);
      
      // Initialize pong tracking
      wsState.lastPongTime = Date.now();
      
      // Handle pong responses if server sends them
      if (wsState.ws) {
        wsState.ws.on("pong", () => {
          wsState.lastPongTime = Date.now();
          logDebug(`Received PONG from ${marketType} WebSocket`);
        });
      }
      
      // Start PING interval for this connection
      this.startPingInterval(marketType);
      
      // Re-subscribe to any previously subscribed assets for this market
      if (wsState.subscriptions.size > 0) {
        const assetIds = Array.from(wsState.subscriptions);
        this.subscribeWebSocket(marketType, assetIds);
      }
    });

    wsState.ws.on("message", (data: WebSocket.Data) => {
      try {
        const rawMessage = data.toString().trim();
        
        // Handle non-JSON messages (like "INVALID OPERATION")
        if (!rawMessage.startsWith("{") && !rawMessage.startsWith("[")) {
          logWarn(`Received non-JSON message from ${marketType} WebSocket: ${rawMessage}`);
          if (rawMessage.includes("INVALID") || rawMessage.includes("ERROR")) {
            logError(`${marketType} WebSocket server error: ${rawMessage}`);
          }
          return;
        }
        
        const parsed = JSON.parse(rawMessage);
        
        // Handle array of messages (common format from Polymarket)
        if (Array.isArray(parsed)) {
          for (const message of parsed) {
            this.handleWebSocketMessage(marketType, message as {
              type?: string;
              event_type?: string;
              channel?: string;
              data?: unknown;
              asset_id?: string;
              market?: string;
              [key: string]: unknown;
            });
          }
        } else {
          // Handle single message object
          this.handleWebSocketMessage(marketType, parsed as {
            type?: string;
            event_type?: string;
            channel?: string;
            data?: unknown;
            asset_id?: string;
            market?: string;
            [key: string]: unknown;
          });
        }
      } catch (error) {
        logError(`Failed to parse ${marketType} WebSocket message:`, error);
        logDebug(`Raw message: ${data.toString().substring(0, 200)}`);
      }
    });

    wsState.ws.on("error", (error) => {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logError(`${marketType} WebSocket error: ${errorMsg}`);
      if (errorMsg.includes("404")) {
        logError(`CRITICAL: ${marketType} WebSocket endpoint returns 404`);
        logError(`Current URL: ${WSS_URL}`);
        if (this.callbacks.onError) {
          this.callbacks.onError(new Error(`${marketType} WebSocket connection failed: ${errorMsg}`));
        }
      } else {
        if (this.callbacks.onError) {
          this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });

    wsState.ws.on("close", (code, reason) => {
      const reasonStr = reason ? reason.toString() : "unknown";
      logWarn(`${marketType} WebSocket closed (code: ${code}, reason: ${reasonStr})`);
      
      // Stop ping/pong intervals for this connection
      if (wsState.pingInterval) {
        clearInterval(wsState.pingInterval);
        wsState.pingInterval = null;
      }
      if (wsState.pongCheckInterval) {
        clearInterval(wsState.pongCheckInterval);
        wsState.pongCheckInterval = null;
      }
      
      wsState.ws = null;
      
      // Only reconnect if it wasn't a normal closure (code 1000)
      if (code !== 1000) {
        logWarn(`${marketType} WebSocket reconnecting in ${this.config.wsReconnectDelayMs}ms...`);
        if (wsState.reconnectTimer) {
          clearTimeout(wsState.reconnectTimer);
        }
        wsState.reconnectTimer = setTimeout(() => {
          this.connectWebSocketForMarket(marketType);
        }, this.config.wsReconnectDelayMs);
      } else {
        logInfo(`${marketType} WebSocket closed normally (code 1000)`);
      }
    });
  }

  /**
   * Connect both WebSocket connections (5m and 15m)
   */
  connectWebSocket(): void {
    this.connectWebSocketForMarket("5m");
    this.connectWebSocketForMarket("15m");
  }

  /**
   * Subscribe to WebSocket channel for a specific market type
   * According to https://docs.polymarket.com/developers/CLOB/websocket/wss-overview
   * For market channel, send message with:
   * - assets_ids: Array of token IDs
   * - operation: "subscribe" or "unsubscribe"
   */
  private subscribeWebSocket(marketType: "5m" | "15m", assetIds: string[]): void {
    const wsState = marketType === "5m" ? this.ws5m : this.ws15m;
    
    if (!wsState.ws || wsState.ws.readyState !== WebSocket.OPEN) {
      logWarn(`${marketType} WebSocket not connected, cannot subscribe`);
      return;
    }

    const message = {
      assets_ids: assetIds,
      operation: "subscribe",
    };

    wsState.ws.send(JSON.stringify(message));
    logDebug(`${marketType} market subscribed to assets: ${assetIds.join(", ")}`);
    
    // Track subscriptions for this market type
    for (const assetId of assetIds) {
      wsState.subscriptions.add(assetId);
    }
  }

  /**
   * Unsubscribe from WebSocket channel for a specific market type
   * According to Polymarket docs, send message with:
   * - assets_ids: Array of token IDs
   * - operation: "unsubscribe"
   */
  private unsubscribeWebSocket(marketType: "5m" | "15m", assetIds: string[]): void {
    const wsState = marketType === "5m" ? this.ws5m : this.ws15m;
    
    if (!wsState.ws || wsState.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const message = {
      assets_ids: assetIds,
      operation: "unsubscribe",
    };

    wsState.ws.send(JSON.stringify(message));
    logDebug(`${marketType} market unsubscribed from assets: ${assetIds.join(", ")}`);
    
    // Remove from tracked subscriptions
    for (const assetId of assetIds) {
      wsState.subscriptions.delete(assetId);
      // Remove message handlers
      wsState.messageHandlers.delete(assetId);
    }
  }

  /**
   * Unsubscribe from a market (clean up handlers and WebSocket subscriptions)
   */
  unsubscribeFromMarket(marketId: string): void {
    const market = this.marketCache.get(marketId);
    if (!market) {
      logWarn(`Market ${marketId} not found in cache, cannot unsubscribe`);
      return;
    }

    const assetIds = [market.tokens.upTokenId, market.tokens.downTokenId];
    
    // Unsubscribe from the appropriate WebSocket (5m or 15m)
    this.unsubscribeWebSocket(market.marketType, assetIds);
    
    // Remove from cache
    this.marketCache.delete(marketId);
    
    // Clear market data references
    if (this.market5m?.marketId === marketId) {
      this.market5m = null;
    }
    if (this.market15m?.marketId === marketId) {
      this.market15m = null;
    }
    
    logInfo(`Unsubscribed from ${market.marketType} market ${marketId} and cleaned up handlers`);
  }

  /**
   * Start PING interval to keep connection alive for a specific market type
   * According to https://docs.polymarket.com/developers/CLOB/websocket/wss-overview
   * Send PING every 30 seconds (increased from 10s to reduce server load)
   */
  private startPingInterval(marketType: "5m" | "15m"): void {
    const wsState = marketType === "5m" ? this.ws5m : this.ws15m;
    
    if (wsState.pingInterval) {
      clearInterval(wsState.pingInterval);
    }
    if (wsState.pongCheckInterval) {
      clearInterval(wsState.pongCheckInterval);
    }
    
    const PONG_TIMEOUT = 90000; // 90 seconds timeout for pong response (3x ping interval)
    
    // Check for pong responses
    wsState.pongCheckInterval = setInterval(() => {
      if (wsState.ws && wsState.ws.readyState === WebSocket.OPEN) {
        const timeSinceLastPong = Date.now() - wsState.lastPongTime;
        if (timeSinceLastPong > PONG_TIMEOUT && wsState.lastPongTime > 0) {
          logWarn(`${marketType} WebSocket: No pong received for ${Math.floor(timeSinceLastPong / 1000)}s, closing connection for reconnect`);
          wsState.ws.close();
        }
      }
    }, 15000); // Check every 15 seconds
    
    wsState.pingInterval = setInterval(() => {
      if (wsState.ws && wsState.ws.readyState === WebSocket.OPEN) {
        // Send PING as plain text, not JSON (some servers expect plain "ping")
        try {
          wsState.ws.send("ping");
          logDebug(`Sent PING to ${marketType} WebSocket to keep connection alive`);
        } catch (error) {
          logError(`Failed to send PING to ${marketType} WebSocket:`, error);
        }
      }
    }, 30000); // Every 30 seconds (reduced frequency to reduce server load)
  }

  /**
   * Handle incoming WebSocket message for a specific market type
   * According to https://docs.polymarket.com/developers/CLOB/websocket/market-channel
   * Messages have event_type field and different structures:
   * - "book": orderbook updates with bids/asks
   * - "price_change": price updates when orders placed/cancelled
   * - "last_trade_price": trade execution events
   * - "best_bid_ask": best bid/ask changes (requires custom_feature_enabled)
   */
  private handleWebSocketMessage(marketType: "5m" | "15m", message: {
    event_type?: string;
    asset_id?: string;
    market?: string;
    bids?: Array<{ price: string; size: string }>;
    asks?: Array<{ price: string; size: string }>;
    // New schema (post Sept 15, 2025): price_changes array with asset_id, best_bid, best_ask inside each change
    price_changes?: Array<{
      asset_id: string;
      price: string;
      size: string;
      side: string;
      best_bid: string;
      best_ask: string;
      hash?: string; // Now per price change, not per message
    }>;
    timestamp?: string;
    hash?: string; // Legacy: only in old schema
    best_bid?: string;
    best_ask?: string;
    price?: string;
    [key: string]: unknown;
  }): void {
    const wsState = marketType === "5m" ? this.ws5m : this.ws15m;
    const eventType = message.event_type;
    const assetId = message.asset_id;

    // Handle "book" event - full orderbook snapshot
    // According to docs: bids/asks are OrderSummary[] with price and size as strings
    if (eventType === "book" && assetId && typeof assetId === "string") {
      const orderbook: OrderBook = {
        bids: (message.bids || []).map((b) => ({ price: b.price, size: b.size })),
        asks: (message.asks || []).map((a) => ({ price: a.price, size: a.size })),
        timestamp: message.timestamp && typeof message.timestamp === "string" ? parseFloat(message.timestamp) : Date.now(),
      };
      
      // Update orderbook via handler (which will update market data)
      const handler = wsState.messageHandlers.get(assetId);
      if (handler) {
        handler(orderbook);
      } else {
        logDebug(`No handler registered for ${marketType} asset ${assetId}, orderbook update skipped`);
      }
    }
    // Handle "price_change" event - incremental price updates
    // New schema (post Sept 15, 2025): price_changes array with asset_id, best_bid, best_ask inside each change
    // See: https://docs.polymarket.com/developers/CLOB/websocket/market-channel-migration-guide
    else if (eventType === "price_change" && message.price_changes) {
      for (const change of message.price_changes) {
        // asset_id is now inside each price change object (not at root level)
        if (!change.asset_id) {
          logWarn(`${marketType} price_change message missing asset_id in price change object`);
          continue;
        }
        
        const handler = wsState.messageHandlers.get(change.asset_id);
        if (handler) {
          // New schema provides best_bid and best_ask directly in each price change
          // Use best_ask as executable buy price for arbitrage
          const priceUpdate = {
            best_bid: parseFloat(change.best_bid || "0"),
            best_ask: parseFloat(change.best_ask || "0"),
            price: parseFloat(change.price),
            size: parseFloat(change.size || "0"),
            side: change.side,
            hash: change.hash, // Hash is now per price change, not per message
          };
          handler(priceUpdate);
        } else {
          logDebug(`No handler registered for ${marketType} asset ${change.asset_id} in price_change`);
        }
      }
    }
    // Handle "best_bid_ask" event - best bid/ask changes (if custom_feature_enabled)
    else if (eventType === "best_bid_ask" && message.asset_id) {
      const handler = wsState.messageHandlers.get(message.asset_id);
      if (handler && message.best_bid && message.best_ask) {
        const priceUpdate = {
          best_bid: parseFloat(message.best_bid),
          best_ask: parseFloat(message.best_ask),
        };
        handler(priceUpdate);
      }
    }
    // Handle "last_trade_price" event - trade execution
    else if (eventType === "last_trade_price" && message.asset_id && message.price) {
      const handler = wsState.messageHandlers.get(message.asset_id);
      if (handler) {
        const tradeUpdate = {
          price: parseFloat(message.price),
          size: message.size ? parseFloat(message.size as string) : 0,
          side: message.side as string,
        };
        handler(tradeUpdate);
      }
    }
    // Fallback: try to find handler by asset_id
    else if (message.asset_id) {
      const handler = wsState.messageHandlers.get(message.asset_id);
      if (handler) {
        handler(message);
      }
    }
  }

  /**
   * Initialize and monitor a market
   */
  async initializeMarket(marketType: MarketType, windowTs: number): Promise<MarketData | null> {
    const event =
      marketType === "5m"
        ? await this.client.getBtc5mEventBySlugTs(windowTs)
        : await this.client.getBtc15mEventBySlugTs(windowTs);

    if (!event) {
      logWarn(`${marketType} market not found for window ${windowTs}`);
      return null;
    }

    const tokens = this.client.getMarketTokens(event);
    if (!tokens) {
      logWarn(`${marketType} market tokens not found`);
      return null;
    }

    // Get market data (contains beat price as lowerBound/upperBound)
    const market = event.markets?.[0];
    if (!market) {
      logWarn(`${marketType} market data not found in event`);
      return null;
    }

    // Use the same method as getBeatPriceFromEvent to get start timestamp
    // This ensures consistency - checks all markets, not just the first one
    // Important for 15m markets which might have multiple markets
    const startTimestamp = this.client.getMarketStartTimestamp(event);
    if (!startTimestamp) {
      logError(`❌ CRITICAL: Could not determine market start timestamp for ${marketType} market`);
      logError(`Event slug: ${event.slug}`);
      logError(`Event has ${event.markets?.length || 0} markets`);
      if (event.markets && event.markets.length > 0) {
        const firstMarket = event.markets[0];
        logError(`First market keys: ${Object.keys(firstMarket || {}).join(", ")}`);
        logError(`First market eventStartTime: ${(firstMarket as any)?.eventStartTime || "N/A"}`);
        logError(`First market startDate: ${(firstMarket as any)?.startDate || "N/A"}`);
      }
      logError(`Event startDate: ${event.startDate || "N/A"}`);
      logError(`Event creationDate: ${event.creationDate || "N/A"}`);
      // Continue anyway, but beat price will be null
    }
    
    const startTime = startTimestamp || 0;
    const endTime = new Date(event.endDate).getTime() / 1000;

    // Get beat price from cache or fetch it
    // Beat price = Chainlink BTC/USD price at market start timestamp (FIXED - never changes)
    // Cache key: market start time (timestamp) - must match the timestamp used in getBeatPriceFromEvent
    let beatPriceValue: number | null = null;
    
    if (!startTimestamp) {
      logWarn(`⚠️  Skipping beat price fetch for ${marketType} market - no start timestamp`);
    } else {
      const cacheKey = Math.floor(startTimestamp); // Use same timestamp as getBeatPriceFromEvent
      
      if (this.beatPriceCache.has(cacheKey)) {
        // Use cached beat price (already fetched for this market start time)
        beatPriceValue = this.beatPriceCache.get(cacheKey)!;
        logInfo(`✅ Using cached beat price for ${marketType} market (startTime: ${cacheKey}): $${beatPriceValue.toFixed(2)}`);
      } else {
        // Fetch beat price from Chainlink at market start time
        logInfo(`🔄 Fetching beat price for ${marketType} market (startTime: ${cacheKey}, slug: ${event.slug})...`);
        beatPriceValue = await this.client.getBeatPriceFromEvent(event);
        if (beatPriceValue === null) {
          logError(`❌ Failed to fetch beat price for ${marketType} market`);
          logError(`   Slug: ${event.slug}`);
          logError(`   Start timestamp: ${cacheKey} (${new Date(cacheKey * 1000).toISOString()})`);
          logError(`   Beat price should be Chainlink BTC/USD price at market start time`);
        } else {
          // Store in cache for future use (same start time = same beat price)
          this.beatPriceCache.set(cacheKey, beatPriceValue);
          logInfo(`✅ Fetched and cached beat price for ${marketType} market (startTime: ${cacheKey}): $${beatPriceValue.toFixed(2)}`);
        }
      }
    }

    // NOTE: For arbitrage bot, we rely ONLY on WebSocket for real-time prices
    // Initial prices will be set to null and updated via WebSocket
    // This ensures minimal latency - no REST polling delays
    const upPrice: number | null = null;
    const downPrice: number | null = null;

    const marketData: MarketData = {
      marketId: event.id,
      marketType,
      eventId: event.id,
      slug: event.slug,
      startTime,
      endTime,
      beatPrice: beatPriceValue
        ? {
            value: beatPriceValue,
            timestamp: startTimestamp || startTime,
            source: "polymarket", // Chainlink BTC/USD at market start time
          }
        : null,
      tokens,
      upPrice,
      downPrice,
      upLiquidity: 0, // Will be updated via WebSocket
      downLiquidity: 0, // Will be updated via WebSocket
      finalFinishPrice: null,
      result: "PENDING",
      priceHistory: [], // Will be populated via WebSocket only
    };

    this.marketCache.set(marketData.marketId, marketData);

    // Log initial market data
    this.logMarketPrices(marketData);

    // Subscribe to WebSocket updates
    this.subscribeToMarketUpdates(marketData);

    return marketData;
  }

  /**
   * Subscribe to WebSocket updates for a market
   * According to https://docs.polymarket.com/developers/CLOB/websocket/market-channel
   * The WebSocket sends different event types:
   * - "book": full orderbook with bids/asks
   * - "price_change": incremental price updates with best_bid/best_ask
   * - "best_bid_ask": best bid/ask changes (if custom_feature_enabled)
   * - "last_trade_price": trade execution events
   */
  private subscribeToMarketUpdates(market: MarketData): void {
    const assetIds = [market.tokens.upTokenId, market.tokens.downTokenId];
    const wsState = market.marketType === "5m" ? this.ws5m : this.ws15m;

    // Set up message handlers for UP token (on the appropriate WebSocket)
    wsState.messageHandlers.set(market.tokens.upTokenId, (data) => {
      if (data && typeof data === "object") {
        // Handle orderbook updates (from "book" event)
        if ("bids" in data && "asks" in data) {
          const orderbook = data as OrderBook;
          this.updateMarketOrderBook(market.marketId, "up", orderbook);
        }
        // Handle price updates (from "price_change" or "best_bid_ask" events)
        // New schema: price_change includes best_bid and best_ask in each change
        else if ("best_bid" in data && "best_ask" in data) {
          const priceData = data as { best_bid: number; best_ask: number; price?: number; side?: string };
          // Use best_ask as executable buy price, best_bid as executable sell price
          // For arbitrage, we need buy price, so use best_ask
          // If best_ask is 0 or invalid, fall back to the trade price if available
          const executablePrice = priceData.best_ask > 0 ? priceData.best_ask : (priceData.price || 0);
          if (executablePrice > 0) {
            this.updateMarketPrice(market.marketId, "up", executablePrice);
          }
        }
        // Handle trade price (from "last_trade_price" event)
        else if ("price" in data && typeof (data as { price: number }).price === "number") {
          const price = (data as { price: number }).price;
          this.updateMarketPrice(market.marketId, "up", price);
        }
      }
    });

    // Set up message handlers for DOWN token (on the appropriate WebSocket)
    wsState.messageHandlers.set(market.tokens.downTokenId, (data) => {
      if (data && typeof data === "object") {
        // Handle orderbook updates (from "book" event)
        if ("bids" in data && "asks" in data) {
          const orderbook = data as OrderBook;
          this.updateMarketOrderBook(market.marketId, "down", orderbook);
        }
        // Handle price updates (from "price_change" or "best_bid_ask" events)
        // New schema: price_change includes best_bid and best_ask in each change
        else if ("best_bid" in data && "best_ask" in data) {
          const priceData = data as { best_bid: number; best_ask: number; price?: number; side?: string };
          // Use best_ask as executable buy price
          // If best_ask is 0 or invalid, fall back to the trade price if available
          const executablePrice = priceData.best_ask > 0 ? priceData.best_ask : (priceData.price || 0);
          if (executablePrice > 0) {
            this.updateMarketPrice(market.marketId, "down", executablePrice);
          }
        }
        // Handle trade price (from "last_trade_price" event)
        else if ("price" in data && typeof (data as { price: number }).price === "number") {
          const price = (data as { price: number }).price;
          this.updateMarketPrice(market.marketId, "down", price);
        }
      }
    });

    // Subscribe to both assets on the appropriate WebSocket (5m or 15m)
    this.subscribeWebSocket(market.marketType, assetIds);
  }

  /**
   * Update market price from WebSocket
   */
  private updateMarketPrice(marketId: string, side: "up" | "down", price: number): void {
    const market = this.marketCache.get(marketId);
    if (!market) return;

    if (side === "up") {
      market.upPrice = price;
    } else {
      market.downPrice = price;
    }

    // Add to price history
    market.priceHistory.push({
      timestamp: Date.now(),
      upPrice: market.upPrice,
      downPrice: market.downPrice,
      source: "websocket",
    });

    // Keep only last 1000 price snapshots
    if (market.priceHistory.length > 1000) {
      market.priceHistory = market.priceHistory.slice(-1000);
    }

    this.marketCache.set(marketId, market);

    // Log real-time prices
    this.logMarketPrices(market);

    // Check for sync
    this.checkSync(market);

    if (this.callbacks.onMarketDataUpdate) {
      this.callbacks.onMarketDataUpdate(market.marketType, market);
    }
  }

  /**
   * Update market orderbook from WebSocket
   */
  private updateMarketOrderBook(marketId: string, side: "up" | "down", orderbook: OrderBook): void {
    const market = this.marketCache.get(marketId);
    if (!market) return;

    // Update executable price from orderbook (best ask for buying)
    const executablePrice = this.client.getBestExecutablePrice(orderbook);
    if (executablePrice !== null) {
      if (side === "up") {
        market.upPrice = executablePrice;
      } else {
        market.downPrice = executablePrice;
      }
      
      // Add to price history
      market.priceHistory.push({
        timestamp: Date.now(),
        upPrice: market.upPrice,
        downPrice: market.downPrice,
        source: "websocket",
      });

      // Keep only last 1000 price snapshots
      if (market.priceHistory.length > 1000) {
        market.priceHistory = market.priceHistory.slice(-1000);
      }
    }

    // Update liquidity
    if (side === "up") {
      market.upLiquidity = this.client.calculateLiquidity(orderbook);
    } else {
      market.downLiquidity = this.client.calculateLiquidity(orderbook);
    }

    this.marketCache.set(marketId, market);
    
    // Log real-time prices
    this.logMarketPrices(market);
    
    // Check for sync and notify callbacks
    this.checkSync(market);
    
    if (this.callbacks.onMarketDataUpdate) {
      this.callbacks.onMarketDataUpdate(market.marketType, market);
    }
  }

  /**
   * Log current market prices in a fixed table format (similar to pm2 status)
   * Updates the same table position in terminal for real-time monitoring
   * Uses debouncing to batch rapid updates and prevent race conditions
   */
  private logMarketPrices(market: MarketData): void {
    // Store market data (always update, even if display is throttled)
    if (market.marketType === "5m") {
      this.market5m = market;
    } else if (market.marketType === "15m") {
      this.market15m = market;
    }

    // Initialize table header on first call
    if (!this.tableInitialized) {
      try {
        this.printTableHeader();
        this.tableInitialized = true;
        this.lastTableUpdate = Date.now();
        // Print initial rows
        this.printTableRows();
      } catch (error) {
        logError("Failed to initialize table display:", error);
        // Fallback: disable table display
        this.tableInitialized = false;
      }
      return;
    }

    // Debounce updates: schedule update instead of immediate update
    // This prevents race conditions from concurrent WebSocket updates
    this.pendingTableUpdate = true;

    // Clear existing timer
    if (this.tableUpdateTimer) {
      clearTimeout(this.tableUpdateTimer);
    }

    // Schedule update after throttle interval
    this.tableUpdateTimer = setTimeout(() => {
      this.flushTableUpdate();
    }, this.TABLE_UPDATE_INTERVAL);
  }

  /**
   * Flush pending table update (called after debounce delay)
   * Uses write lock to prevent concurrent writes
   */
  private flushTableUpdate(): void {
    // Check if there's a pending update
    if (!this.pendingTableUpdate) {
      return;
    }

    // Check if already writing (prevent concurrent writes)
    if (this.isWritingTable) {
      // Reschedule if currently writing
      this.tableUpdateTimer = setTimeout(() => {
        this.flushTableUpdate();
      }, this.TABLE_UPDATE_INTERVAL);
      return;
    }

    // Acquire write lock
    this.isWritingTable = true;
    this.pendingTableUpdate = false;

    try {
      const now = Date.now();
      // Only update if enough time has passed (additional safety check)
      if (now - this.lastTableUpdate >= this.TABLE_UPDATE_INTERVAL) {
        this.lastTableUpdate = now;
        this.printTableRows();
      }
    } catch (error) {
      logError("Failed to update table display:", error);
      // Reset table state on error (will re-initialize on next update)
      this.tableInitialized = false;
    } finally {
      // Release write lock
      this.isWritingTable = false;
    }
  }

  /**
   * Print table header (similar to pm2 status)
   */
  private printTableHeader(): void {
    const header = 
      "\n" +
      "┌─────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐\n" +
      "│ Market      │ Beat Price    │ UP Price     │ DOWN Price   │ Sum (UP+DOWN)│ Status       │\n" +
      "├─────────────┼──────────────┼──────────────┼──────────────┼──────────────┼──────────────┤\n";
    process.stdout.write(header);
  }

  /**
   * Print table rows with current market data
   * Uses ANSI escape codes to update in place without scrolling
   * Wrapped in error handling for stability
   */
  private printTableRows(): void {
    // Validate table is initialized
    if (!this.tableInitialized) {
      // Re-initialize if lost
      try {
        this.printTableHeader();
        this.tableInitialized = true;
      } catch (error) {
        logError("Failed to re-initialize table:", error);
        return;
      }
    }

    try {
      // If table was already initialized, move cursor back to start of data rows
      // After previous print: cursor is 1 line below footer
      // To get to first row: move up 3 lines (row5m + row15m + footer)
      // Only move if we're not at the start (avoid moving if cursor position is unknown)
      if (this.tableInitialized) {
        // Move cursor up 3 lines to get back to the first data row
        // Use try-catch in case terminal doesn't support ANSI
        process.stdout.write(`\x1b[3A`);
      }

      // Print both market rows
      const row5m = this.formatMarketRow(this.market5m, "5m");
      const row15m = this.formatMarketRow(this.market15m, "15m");
      
      // Move to beginning of line, clear entire line, write row 1 (5m market), newline
      process.stdout.write(`\r\x1b[2K${row5m}\n`);
      
      // Move to beginning of line, clear entire line, write row 2 (15m market), newline
      process.stdout.write(`\r\x1b[2K${row15m}\n`);
      
      // Move to beginning of line, clear entire line, write footer, newline
      process.stdout.write(`\r\x1b[2K└─────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘\n`);
      
      // After printing, cursor is 1 line below footer (ready for next update)
    } catch (error) {
      // If ANSI codes fail (e.g., stdout redirected), fallback to regular logging
      logError("Table display failed (ANSI not supported?):", error);
      logInfo(`5M Market: Beat=${this.market5m?.beatPrice?.value || "N/A"}, UP=${this.market5m?.upPrice || "N/A"}, DOWN=${this.market5m?.downPrice || "N/A"}`);
      logInfo(`15M Market: Beat=${this.market15m?.beatPrice?.value || "N/A"}, UP=${this.market15m?.upPrice || "N/A"}, DOWN=${this.market15m?.downPrice || "N/A"}`);
      // Disable table display to prevent repeated errors
      this.tableInitialized = false;
    }
  }

  /**
   * Format a single market row for the table
   */
  private formatMarketRow(market: MarketData | null, marketType: string): string {
    const marketName = marketType.toUpperCase();
    
    const beatPriceStr = market?.beatPrice 
      ? `$${market.beatPrice.value.toFixed(2)}` 
      : "N/A";
    
    const upPriceStr = market?.upPrice !== null && market?.upPrice !== undefined
      ? market.upPrice.toFixed(4) 
      : "N/A";
    
    const downPriceStr = market?.downPrice !== null && market?.downPrice !== undefined
      ? market.downPrice.toFixed(4) 
      : "N/A";
    
    const sumPrice = market?.upPrice !== null && market?.upPrice !== undefined && 
                     market?.downPrice !== null && market?.downPrice !== undefined
      ? (market.upPrice + market.downPrice).toFixed(4) 
      : "N/A";
    
    // Determine status
    // Beat price is FIXED (Chainlink BTC/USD at market start time) - never changes
    // UP/DOWN prices are LIVE (from orderbook) - always changing
    let status = "⏳ Waiting";
    if (market) {
      // Check if beat price is available (this is fixed at market start)
      const hasBeatPrice = market.beatPrice !== null && market.beatPrice !== undefined;
      
      if (market.upPrice !== null && market.downPrice !== null) {
        const sum = market.upPrice + market.downPrice;
        const sumDiff = Math.abs(sum - 1.0);
        
        // If sum is very close to 1.0 (within 0.005), market is "Ready"
        // If sum is slightly off (0.005-0.02), show "Mispriced" (arbitrage opportunity)
        // If sum is way off (>0.02), show "Error"
        if (sumDiff < 0.005) {
          status = hasBeatPrice ? "✅ Ready" : "🟡 No Beat";
        } else if (sumDiff < 0.02) {
          status = hasBeatPrice ? "💰 Mispriced" : "🟡 No Beat";
        } else {
          status = "❌ Error";
        }
      } else if (market.upPrice !== null || market.downPrice !== null) {
        status = "🔄 Partial";
      } else if (hasBeatPrice) {
        status = "⏳ Waiting";
      }
    }

    // Format row with fixed column widths
    return `│ ${marketName.padEnd(11)} │ ${beatPriceStr.padEnd(12)} │ ${upPriceStr.padEnd(12)} │ ${downPriceStr.padEnd(12)} │ ${sumPrice.padEnd(12)} │ ${status.padEnd(12)} │`;
  }

  /**
   * Check if markets are synchronized (endTime_5m == endTime_15m)
   */
  private checkSync(market: MarketData): void {
    // Find the other market
    const otherMarketType: MarketType = market.marketType === "5m" ? "15m" : "5m";
    const otherMarket = Array.from(this.marketCache.values()).find(
      (m) => m.marketType === otherMarketType && m.endTime === market.endTime,
    );

    if (otherMarket && this.callbacks.onSyncDetected) {
      this.callbacks.onSyncDetected(
        market.marketType === "5m" ? market : otherMarket,
        market.marketType === "15m" ? market : otherMarket,
      );
    }
  }

  /**
   * Get market data from cache
   */
  getMarketData(marketId: string): MarketData | null {
    return this.marketCache.get(marketId) || null;
  }

  /**
   * Get all markets of a type
   */
  getMarketsByType(marketType: MarketType): MarketData[] {
    return Array.from(this.marketCache.values()).filter((m) => m.marketType === marketType);
  }

  /**
   * Get synchronized markets (same endTime)
   */
  getSynchronizedMarkets(): { market5m: MarketData; market15m: MarketData } | null {
    const markets5m = this.getMarketsByType("5m");
    const markets15m = this.getMarketsByType("15m");

    for (const m5 of markets5m) {
      for (const m15 of markets15m) {
        if (m5.endTime === m15.endTime) {
          return { market5m: m5, market15m: m15 };
        }
      }
    }
    return null;
  }

  /**
   * Check if data is stale
   */
  isDataStale(market: MarketData): boolean {
    const lastUpdate = market.priceHistory[market.priceHistory.length - 1]?.timestamp || 0;
    const age = Date.now() - lastUpdate;
    return age > this.config.maxDataAgeMs;
  }

  /**
   * Disconnect WebSocket and cleanup all resources
   */
  disconnect(): void {
    // Clear table update timer
    if (this.tableUpdateTimer) {
      clearTimeout(this.tableUpdateTimer);
      this.tableUpdateTimer = null;
    }
    this.pendingTableUpdate = false;
    this.isWritingTable = false;
    
    // Disconnect 5m WebSocket
    this.disconnectWebSocket("5m");
    
    // Disconnect 15m WebSocket
    this.disconnectWebSocket("15m");
  }

  /**
   * Disconnect WebSocket for a specific market type
   */
  private disconnectWebSocket(marketType: "5m" | "15m"): void {
    const wsState = marketType === "5m" ? this.ws5m : this.ws15m;
    
    // Clear ping/pong intervals
    if (wsState.pingInterval) {
      clearInterval(wsState.pingInterval);
      wsState.pingInterval = null;
    }
    if (wsState.pongCheckInterval) {
      clearInterval(wsState.pongCheckInterval);
      wsState.pongCheckInterval = null;
    }
    
    // Clear reconnect timer
    if (wsState.reconnectTimer) {
      clearTimeout(wsState.reconnectTimer);
      wsState.reconnectTimer = null;
    }
    
    // Close WebSocket connection
    if (wsState.ws) {
      wsState.ws.removeAllListeners();
      wsState.ws.close();
      wsState.ws = null;
    }
    
    // Clear subscriptions and handlers
    wsState.subscriptions.clear();
    wsState.messageHandlers.clear();
    
    logInfo(`${marketType} market WebSocket disconnected and cleaned up`);
  }
}
