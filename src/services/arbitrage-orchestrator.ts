/**
 * Main orchestrator service that coordinates all components
 * Implements latency-aware architecture with risk controls
 */

import { PolymarketClient } from "../clients/polymarket";
import { MarketDataManager } from "./market-data-manager";
import { ArbitrageDetector } from "./arbitrage-detector";
import { TradeExecutor, UnwindFailedError } from "./trade-executor";
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
  // Throttle market-data DB writes: at 100+ WebSocket ticks/sec, writing on
  // every update causes thousands of queued MongoDB ops and an OOM crash.
  // 5 seconds is plenty for observability; trades use their own write path.
  private readonly MARKET_DATA_WRITE_INTERVAL_MS = 5000;
  private lastMarketDataWrite: Map<string, number> = new Map();

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

    // Ensure wallet approval before starting
    if (this.config.enableTrading) {
      logInfo("Ensuring wallet approval...");
      await this.executor.ensureApproved();
    }

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
  private currentWindow5m: number = 0;
  private currentWindow15m: number = 0;

  private async initializeMarkets(): Promise<void> {
    const window5m = this.client.getCurrent5mWindowTs();
    const window15m = this.client.getAligned15mWindow(window5m);

    // Store current windows
    this.currentWindow5m = window5m;
    this.currentWindow15m = window15m;

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
   * Check if markets need to be switched (window rollover)
   * Returns true if new markets should be initialized
   */
  private shouldSwitchMarkets(): boolean {
    const currentWindow5m = this.client.getCurrent5mWindowTs();
    const currentWindow15m = this.client.getAligned15mWindow(currentWindow5m);

    // Check if 5m window changed
    if (currentWindow5m !== this.currentWindow5m) {
      logInfo(`5m window rollover detected: ${this.currentWindow5m} → ${currentWindow5m}`);
      return true;
    }

    // Check if 15m window changed
    if (currentWindow15m !== this.currentWindow15m) {
      logInfo(`15m window rollover detected: ${this.currentWindow15m} → ${currentWindow15m}`);
      return true;
    }

    return false;
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

      // Check if markets need to be switched (window rollover)
      // This ensures we're always targeting CURRENT markets, not old ones
      if (this.shouldSwitchMarkets()) {
        logInfo("Window rollover detected, switching to current markets");
        
        // Unsubscribe from old markets
        const oldMarkets5m = this.marketDataManager.getMarketsByType("5m");
        const oldMarkets15m = this.marketDataManager.getMarketsByType("15m");
        
        for (const market of [...oldMarkets5m, ...oldMarkets15m]) {
          const assetIds = [market.tokens.upTokenId, market.tokens.downTokenId];
          this.marketDataManager.unsubscribeFromMarket(market.marketId);
          logInfo(`Unsubscribed from old market ${market.marketId} (assets: ${assetIds.join(", ")})`);
        }
        
        // Initialize new current markets
        await this.initializeMarkets();
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
   * Handle market data update (throttled DB write)
   */
  private handleMarketDataUpdate(marketType: "5m" | "15m", data: MarketData): void {
    logDebug(`Market data updated: ${marketType} market ${data.marketId}`);
    const now = Date.now();
    const lastWrite = this.lastMarketDataWrite.get(data.marketId) ?? 0;
    if (now - lastWrite >= this.MARKET_DATA_WRITE_INTERVAL_MS) {
      this.lastMarketDataWrite.set(data.marketId, now);
      this.storeMarketData(data).catch((error) => {
        logError("Failed to store market data update:", error);
      });
    }
  }

  /**
   * Handle synchronized market detection
   */
  private async handleSyncDetected(market5m: MarketData, market15m: MarketData): Promise<void> {
    //logInfo(`Synchronized markets detected: endTime=${market5m.endTime}`);
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
      // Volatility gate — abort if either market is moving too fast to arb safely
      if (this.detector.isMarketTooVolatile(market5m) || this.detector.isMarketTooVolatile(market15m)) {
        logWarn(
          `Volatile market — skipping arb (5m: ${market5m.marketId}, 15m: ${market15m.marketId})`,
        );
        return;
      }

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

    // Apply history-based slippage estimates to each leg's order price.
    // For FOK orders this sets the maximum price we're willing to pay,
    // accommodating tick-level movement between detection and submission.
    const upMarketData   = upMarket   === "5m" ? market5m : market15m;
    const downMarketData = downMarket === "5m" ? market5m : market15m;

    const upSlippage   = this.detector.estimateSlippageFromHistory(upMarketData,   "up");
    const downSlippage = this.detector.estimateSlippageFromHistory(downMarketData, "down");

    const adjustedUpPrice   = opportunity.prices.upPrice   * (1 + upSlippage);
    const adjustedDownPrice = opportunity.prices.downPrice * (1 + downSlippage);

    // If slippage pushes the combined cost above threshold, the arb is no
    // longer profitable after execution costs — skip rather than trade at a loss
    if (adjustedUpPrice + adjustedDownPrice >= this.config.arbThreshold) {
      logWarn(
        `Slippage-adjusted sum ${(adjustedUpPrice + adjustedDownPrice).toFixed(4)} ` +
        `>= threshold ${this.config.arbThreshold} — skipping trade ` +
        `(upSlippage: ${(upSlippage * 100).toFixed(2)}%, downSlippage: ${(downSlippage * 100).toFixed(2)}%)`,
      );
      return;
    }

    logDebug(
      `Slippage estimates — UP: ${(upSlippage * 100).toFixed(2)}% → ${adjustedUpPrice.toFixed(4)}, ` +
      `DOWN: ${(downSlippage * 100).toFixed(2)}% → ${adjustedDownPrice.toFixed(4)}`,
    );

    const tradeParams = {
      upTokenId,
      downTokenId,
      upMarket,
      downMarket,
      upPrice: adjustedUpPrice,
      downPrice: adjustedDownPrice,
      quantity: this.config.defaultQuantity,
      orderType,
      limitPrice,
    };

    logInfo(`Executing arbitrage trade: ${opportunity.case}, sum=${opportunity.prices.sumPrice.toFixed(4)}`);

    try {
      const execution = await this.executor.executeTradeBatch(tradeParams);

      // Store trade record
      await this.storeTradeRecord(market5m, market15m, execution);
      this.jsonLogger.logTradeExecution(market5m, market15m, execution);
      this.dailyTradeCount++;
    } catch (error) {
      if (error instanceof UnwindFailedError) {
        // A naked position exists. Persist the partial execution record for
        // post-mortem, then halt immediately. Do NOT continue trading.
        logError(
          `[CRITICAL] UNWIND FAILED — HALTING BOT IMMEDIATELY.\n${error.message}`,
        );
        try {
          await this.storeTradeRecord(market5m, market15m, error.partialExecution);
          this.jsonLogger.logTradeExecution(market5m, market15m, error.partialExecution);
        } catch (dbErr) {
          logError("Failed to persist unwind-failure record:", dbErr);
        }
        await this.stop();
        return;
      }
      // Unexpected errors in the execution path should not crash the bot loop,
      // but do log them at error level.
      logError("Unexpected error in executeArbitrageTrade:", error);
    }
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
