/**
 * Main orchestrator service that coordinates all components
 * Implements latency-aware architecture with risk controls
 */

import { PolymarketClient } from "../clients/polymarket";
import { MarketDataManager } from "./market-data-manager";
import { ArbitrageDetector } from "./arbitrage-detector";
import { TradeExecutor } from "./trade-executor";
import { DatabaseService } from "./database";
import { JsonLogger } from "./json-logger";
import { logInfo, logError, logWarn, logDebug, logSyncDetected } from "../utils/logger";
import { getConfig } from "../config";
import type { MarketData, ArbitrageOpportunity, TradeExecution } from "../types";

export class ArbitrageOrchestrator {
  private client: PolymarketClient;
  private marketDataManager: MarketDataManager;
  private detector: ArbitrageDetector;
  private executor: TradeExecutor;
  private database: DatabaseService;
  private jsonLogger: JsonLogger;
  private config = getConfig();
  private isRunning = false;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private dailyTradeCount = 0;
  private lastTradeDate = new Date().toDateString();

  constructor() {
    this.client = new PolymarketClient();
    this.detector = new ArbitrageDetector();
    this.executor = new TradeExecutor();
    this.database = new DatabaseService();
    this.jsonLogger = new JsonLogger();

    this.marketDataManager = new MarketDataManager(this.client, {
      onMarketDataUpdate: (marketType, data) => {
        this.handleMarketDataUpdate(marketType, data);
      },
      onSyncDetected: (market5m, market15m) => {
        this.handleSyncDetected(market5m, market15m);
      },
      onError: (error) => {
        logError("Market data manager error:", error);
      },
    });
  }

  /**
   * Start the arbitrage bot
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logWarn("Orchestrator already running");
      return;
    }

    logInfo("Starting BTC 5-15 minute arbitrage bot");

    // Connect to database
    await this.database.connect();

    // Connect WebSocket
    this.marketDataManager.connectWebSocket();

    // Initialize current markets
    await this.initializeMarkets();

    // Start monitoring loop
    this.isRunning = true;
    this.monitoringInterval = setInterval(() => {
      this.monitoringLoop();
    }, 1000); // Check every second

    logInfo("Arbitrage bot started");
  }

  /**
   * Stop the arbitrage bot
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logInfo("Stopping arbitrage bot");

    this.isRunning = false;

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    this.marketDataManager.disconnect();
    await this.database.disconnect();

    logInfo("Arbitrage bot stopped");
  }

  /**
   * Initialize current markets
   */
  private async initializeMarkets(): Promise<void> {
    const window5m = this.client.getCurrent5mWindowTs();
    const window15m = this.client.getAligned15mWindow(window5m);

    logInfo(`Initializing markets: 5m=${window5m}, 15m=${window15m}`);

    const market5m = await this.marketDataManager.initializeMarket("5m", window5m);
    const market15m = await this.marketDataManager.initializeMarket("15m", window15m);

    if (market5m) {
      logInfo(`5m market initialized: ${market5m.marketId}`);
    }
    if (market15m) {
      logInfo(`15m market initialized: ${market15m.marketId}`);
    }

    // Store market data in database
    if (market5m) {
      await this.storeMarketData(market5m);
    }
    if (market15m) {
      await this.storeMarketData(market15m);
    }
  }

  /**
   * Main monitoring loop
   */
  private async monitoringLoop(): Promise<void> {
    try {
      // Reset daily trade count if new day
      const currentDate = new Date().toDateString();
      if (currentDate !== this.lastTradeDate) {
        this.dailyTradeCount = 0;
        this.lastTradeDate = currentDate;
      }

      // Check for synchronized markets
      const syncMarkets = this.marketDataManager.getSynchronizedMarkets();
      if (syncMarkets) {
        await this.processSynchronizedMarkets(syncMarkets.market5m, syncMarkets.market15m);
      }

      // Check for stale data
      const allMarkets = [
        ...this.marketDataManager.getMarketsByType("5m"),
        ...this.marketDataManager.getMarketsByType("15m"),
      ];

      for (const market of allMarkets) {
        if (this.marketDataManager.isDataStale(market)) {
          logWarn(`Stale data detected for market ${market.marketId}`);
        }

        // Cancel orders near endTime (requirement 11)
        const timeToEnd = market.endTime * 1000 - Date.now();
        if (timeToEnd < this.config.cancelBeforeEndTimeMs && timeToEnd > 0) {
          logWarn(`Market ${market.marketId} ending soon, canceling pending orders`);
          // TODO: Implement order cancellation
        }
      }
    } catch (error) {
      logError("Error in monitoring loop:", error);
    }
  }

  /**
   * Handle market data update
   */
  private handleMarketDataUpdate(marketType: "5m" | "15m", data: MarketData): void {
    logDebug(`Market data updated: ${marketType} market ${data.marketId}`);
    // Update database
    this.storeMarketData(data).catch((error) => {
      logError("Failed to store market data update:", error);
    });
  }

  /**
   * Handle synchronized market detection
   */
  private async handleSyncDetected(market5m: MarketData, market15m: MarketData): Promise<void> {
    logInfo(`Synchronized markets detected: endTime=${market5m.endTime}`);
    await this.processSynchronizedMarkets(market5m, market15m);
  }

  /**
   * Process synchronized markets for arbitrage
   */
  private async processSynchronizedMarkets(market5m: MarketData, market15m: MarketData): Promise<void> {
    // Validate data freshness
    if (this.marketDataManager.isDataStale(market5m) || this.marketDataManager.isDataStale(market15m)) {
      logWarn("Stale data detected, skipping arbitrage check");
      return;
    }

    // Detect arbitrage opportunity
    const opportunity = this.detector.detectArbitrage(market5m, market15m);

    if (opportunity.exists && opportunity.prices && opportunity.direction) {
      // Log sync detection (requirement 9.1)
      logSyncDetected(
        opportunity.direction,
        {
          upPrice: opportunity.prices.upPrice,
          downPrice: opportunity.prices.downPrice,
        },
        opportunity.prices.sumPrice,
        Date.now(),
      );

      // Log to JSON (requirement 9.2)
      this.jsonLogger.logSyncDetected(market5m, market15m, opportunity);

      // Check risk controls
      if (!this.checkRiskControls()) {
        logWarn("Risk controls triggered, skipping trade");
        return;
      }

      // Execute trade
      if (this.config.enableTrading) {
        await this.executeArbitrageTrade(market5m, market15m, opportunity);
      } else {
        logInfo("Trading disabled, skipping execution");
      }
    }
  }

  /**
   * Execute arbitrage trade
   */
  private async executeArbitrageTrade(
    market5m: MarketData,
    market15m: MarketData,
    opportunity: ArbitrageOpportunity,
  ): Promise<void> {
    if (!opportunity.prices || !opportunity.direction) {
      return;
    }

    const upMarket = opportunity.direction.upMarket;
    const downMarket = opportunity.direction.downMarket;

    const upTokenId = upMarket === "5m" ? market5m.tokens.upTokenId : market15m.tokens.upTokenId;
    const downTokenId = downMarket === "5m" ? market5m.tokens.downTokenId : market15m.tokens.downTokenId;

    const orderType = this.detector.getOrderType(opportunity);
    const limitPrice = orderType === "limit" 
      ? this.detector.calculateLimitPrice(opportunity.prices.upPrice, opportunity)
      : undefined;

    const tradeParams = {
      upTokenId,
      downTokenId,
      upMarket,
      downMarket,
      upPrice: opportunity.prices.upPrice,
      downPrice: opportunity.prices.downPrice,
      quantity: this.config.defaultQuantity,
      orderType,
      limitPrice,
    };

    logInfo(`Executing arbitrage trade: ${opportunity.case}, sum=${opportunity.prices.sumPrice.toFixed(4)}`);

    const execution = await this.executor.executeTrade(tradeParams);

    // Store trade record (requirement 8.1)
    await this.storeTradeRecord(market5m, market15m, execution);

    // Log execution
    this.jsonLogger.logTradeExecution(market5m, market15m, execution);

    this.dailyTradeCount++;
  }

  /**
   * Check risk controls
   */
  private checkRiskControls(): boolean {
    // Daily trade limit
    if (this.dailyTradeCount >= this.config.maxDailyTrades) {
      logWarn(`Daily trade limit reached: ${this.dailyTradeCount}/${this.config.maxDailyTrades}`);
      return false;
    }

    // Additional risk checks can be added here
    return true;
  }

  /**
   * Store trade record in database
   */
  private async storeTradeRecord(
    market5m: MarketData,
    market15m: MarketData,
    execution: TradeExecution,
  ): Promise<void> {
    const tradeRecord = {
      timestamp: execution.timestamp,
      market5_id: market5m.marketId,
      market15_id: market15m.marketId,
      direction: execution.direction,
      price_up: execution.prices.upPrice,
      price_down: execution.prices.downPrice,
      sum_price: execution.prices.sumPrice,
      quantity: execution.quantity,
      latency_ms: execution.latencyMs,
      status: execution.status,
      up_order_id: execution.upOrderId,
      down_order_id: execution.downOrderId,
      pnl_estimate: execution.pnlEstimate,
      error: execution.error,
    };

    await this.database.storeTrade(tradeRecord);
  }

  /**
   * Store market data in database
   */
  private async storeMarketData(market: MarketData): Promise<void> {
    const marketRecord = {
      market_id: market.marketId,
      market_type: market.marketType,
      event_id: market.eventId,
      slug: market.slug,
      start_time: market.startTime,
      end_time: market.endTime,
      beat_price: market.beatPrice?.value || null,
      beat_price_timestamp: market.beatPrice?.timestamp || null,
      final_finish_price: market.finalFinishPrice,
      result: market.result,
      price_timeline: market.priceHistory,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    await this.database.storeMarketData(marketRecord);
  }
}
