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

const WSS_URL = "wss://ws-subscriptions-clob.polymarket.com";

export interface MarketDataCallbacks {
  onMarketDataUpdate?: (marketType: MarketType, data: MarketData) => void;
  onSyncDetected?: (market5m: MarketData, market15m: MarketData) => void;
  onError?: (error: Error) => void;
}

export class MarketDataManager {
  private client: PolymarketClient;
  private ws: WebSocket | null = null;
  private wsReconnectTimer: NodeJS.Timeout | null = null;
  private wsSubscriptions: Set<string> = new Set();
  private wsMessageHandlers: Map<string, (data: unknown) => void> = new Map();
  private marketCache: Map<string, MarketData> = new Map();
  private callbacks: MarketDataCallbacks;
  private config = getConfig();

  constructor(client: PolymarketClient, callbacks: MarketDataCallbacks) {
    this.client = client;
    this.callbacks = callbacks;
  }

  /**
   * Connect to WebSocket
   */
  connectWebSocket(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    logInfo("Connecting to Polymarket WebSocket...");
    this.ws = new WebSocket(WSS_URL);

    this.ws.on("open", () => {
      logInfo("WebSocket connected");
      // Re-subscribe to all previous subscriptions
      for (const sub of this.wsSubscriptions) {
        this.subscribeWebSocket(sub);
      }
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString()) as {
          type: string;
          channel?: string;
          data?: unknown;
        };
        this.handleWebSocketMessage(message);
      } catch (error) {
        logError("Failed to parse WebSocket message:", error);
      }
    });

    this.ws.on("error", (error) => {
      logError("WebSocket error:", error);
    });

    this.ws.on("close", () => {
      logWarn("WebSocket closed, reconnecting in 5s...");
      this.ws = null;
      if (this.wsReconnectTimer) {
        clearTimeout(this.wsReconnectTimer);
      }
      this.wsReconnectTimer = setTimeout(() => {
        this.connectWebSocket();
      }, this.config.wsReconnectDelayMs);
    });
  }

  /**
   * Subscribe to WebSocket channel
   */
  private subscribeWebSocket(channel: string): void {
    this.wsSubscriptions.add(channel);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const message = {
        type: "subscribe",
        channel,
      };
      this.ws.send(JSON.stringify(message));
      logDebug("Subscribed to channel:", channel);
    }
  }

  /**
   * Unsubscribe from WebSocket channel
   */
  private unsubscribeWebSocket(channel: string): void {
    this.wsSubscriptions.delete(channel);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const message = {
        type: "unsubscribe",
        channel,
      };
      this.ws.send(JSON.stringify(message));
      logDebug("Unsubscribed from channel:", channel);
    }
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleWebSocketMessage(message: { type: string; channel?: string; data?: unknown }): void {
    if (message.channel) {
      const handler = this.wsMessageHandlers.get(message.channel);
      if (handler) {
        handler(message.data);
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

    const startTime = new Date(event.startDate || event.creationDate || "").getTime() / 1000;
    const endTime = new Date(event.endDate).getTime() / 1000;

    // Fetch beat price (BTC price at market start)
    const beatPriceValue = await this.client.getBtcPriceAtTimestamp(startTime);
    if (beatPriceValue === null) {
      logWarn(`Failed to fetch beat price for ${marketType} market`);
    }

    // Fetch initial prices
    const upPriceData = await this.client.getTokenPrice(tokens.upTokenId, "buy");
    const downPriceData = await this.client.getTokenPrice(tokens.downTokenId, "buy");

    // Fetch orderbooks
    const upOrderBook = await this.client.getOrderBook(tokens.upTokenId);
    const downOrderBook = await this.client.getOrderBook(tokens.downTokenId);

    const upPrice = upPriceData?.price ? parseFloat(upPriceData.price) : null;
    const downPrice = downPriceData?.price ? parseFloat(downPriceData.price) : null;

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
            timestamp: startTime,
            source: "coingecko",
          }
        : null,
      tokens,
      upPrice,
      downPrice,
      upLiquidity: this.client.calculateLiquidity(upOrderBook),
      downLiquidity: this.client.calculateLiquidity(downOrderBook),
      finalFinishPrice: null,
      result: "PENDING",
      priceHistory: [
        {
          timestamp: Date.now(),
          upPrice,
          downPrice,
          source: "rest",
        },
      ],
    };

    this.marketCache.set(marketData.marketId, marketData);

    // Subscribe to WebSocket updates
    this.subscribeToMarketUpdates(marketData);

    return marketData;
  }

  /**
   * Subscribe to WebSocket updates for a market
   */
  private subscribeToMarketUpdates(market: MarketData): void {
    // Subscribe to price updates
    const upPriceChannel = `price:${market.tokens.upTokenId}`;
    const downPriceChannel = `price:${market.tokens.downTokenId}`;

    this.wsMessageHandlers.set(upPriceChannel, (data) => {
      if (data && typeof data === "object" && "price" in data) {
        const price = parseFloat((data as { price: string }).price);
        this.updateMarketPrice(market.marketId, "up", price);
      }
    });

    this.wsMessageHandlers.set(downPriceChannel, (data) => {
      if (data && typeof data === "object" && "price" in data) {
        const price = parseFloat((data as { price: string }).price);
        this.updateMarketPrice(market.marketId, "down", price);
      }
    });

    // Subscribe to orderbook updates
    const upBookChannel = `orderbook:${market.tokens.upTokenId}`;
    const downBookChannel = `orderbook:${market.tokens.downTokenId}`;

    this.wsMessageHandlers.set(upBookChannel, (data) => {
      if (data && typeof data === "object") {
        const orderbook = data as OrderBook;
        this.updateMarketOrderBook(market.marketId, "up", orderbook);
      }
    });

    this.wsMessageHandlers.set(downBookChannel, (data) => {
      if (data && typeof data === "object") {
        const orderbook = data as OrderBook;
        this.updateMarketOrderBook(market.marketId, "down", orderbook);
      }
    });

    this.subscribeWebSocket(upPriceChannel);
    this.subscribeWebSocket(downPriceChannel);
    this.subscribeWebSocket(upBookChannel);
    this.subscribeWebSocket(downBookChannel);
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

    // Update executable price from orderbook
    const executablePrice = this.client.getBestExecutablePrice(orderbook);
    if (executablePrice !== null) {
      if (side === "up") {
        market.upPrice = executablePrice;
      } else {
        market.downPrice = executablePrice;
      }
    }

    // Update liquidity
    if (side === "up") {
      market.upLiquidity = this.client.calculateLiquidity(orderbook);
    } else {
      market.downLiquidity = this.client.calculateLiquidity(orderbook);
    }

    this.marketCache.set(marketId, market);
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
   * Disconnect WebSocket
   */
  disconnect(): void {
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
