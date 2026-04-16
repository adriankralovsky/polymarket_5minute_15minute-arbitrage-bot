/**
 * Main orchestrator service that coordinates all components
 * Implements latency-aware architecture with risk controls
 */

import { randomUUID } from "crypto";
import { PolymarketClient } from "../clients/polymarket";
import { MarketDataManager } from "./market-data-manager";
import { ArbitrageDetector } from "./arbitrage-detector";
import { TradeExecutor, UnwindFailedError } from "./trade-executor";
import { DatabaseService } from "./database";
import { JsonLogger } from "./json-logger";
import { logInfo, logError, logWarn, logDebug, logSyncDetected } from "../utils/logger";
import { sendCriticalAlert } from "../utils/alert";
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
  private isProcessingArb = false; // re-entrancy guard for processSynchronizedMarkets
  // Set permanently on UnwindFailedError halt — blocks all further trading even
  // if isProcessingArb is cleared before stop() finishes.
  private isHalting = false;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private dailyTradeCount = 0;
  private lastTradeDate = new Date().toDateString();
  // Track which markets have already had their pre-expiry cancel fired this window.
  // Prevents the 1-second monitoring loop from issuing redundant cancel requests.
  private cancelledMarketsBeforeExpiry: Set<string> = new Set();
  // Throttle market-data DB writes: at 100+ WebSocket ticks/sec, writing on
  // every update causes thousands of queued MongoDB ops and an OOM crash.
  // 5 seconds is plenty for observability; trades use their own write path.
  private readonly MARKET_DATA_WRITE_INTERVAL_MS = 5000;
  private lastMarketDataWrite: Map<string, number> = new Map();
  // Track markets that have already had finalResolution written so we don't
  // poll Polymarket repeatedly for a result we already have.
  private resolvedMarkets: Set<string> = new Set();

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
        this.handleSyncDetected(market5m, market15m).catch((err) => {
          logError("handleSyncDetected unhandled error:", err);
        });
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
    if (this.isHalting) return; // bot is shutting down after unwind failure
    try {
      // Reset daily trade count if new day
      const currentDate = new Date().toDateString();
      if (currentDate !== this.lastTradeDate) {
        this.dailyTradeCount = 0;
        this.lastTradeDate = currentDate;
      }

      // Check if markets need to be switched (window rollover).
      // Defer if a trade is in-flight: the rollover would null out market refs that
      // the in-progress executeArbitrageTrade may still be referencing.
      if (this.shouldSwitchMarkets()) {
        if (this.isProcessingArb) {
          logDebug("Window rollover deferred — arb execution in flight");
        } else {
          logInfo("Window rollover detected, switching to current markets");

          // Unsubscribe from old markets
          const oldMarkets5m = this.marketDataManager.getMarketsByType("5m");
          const oldMarkets15m = this.marketDataManager.getMarketsByType("15m");

          for (const market of [...oldMarkets5m, ...oldMarkets15m]) {
            const assetIds = [market.tokens.upTokenId, market.tokens.downTokenId];
            this.marketDataManager.unsubscribeFromMarket(market.marketId);
            logInfo(`Unsubscribed from old market ${market.marketId} (assets: ${assetIds.join(", ")})`);
          }

          // Clear pre-expiry cancel tracking for the new window
          this.cancelledMarketsBeforeExpiry.clear();

          // Initialize new current markets
          await this.initializeMarkets();
        }
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

        // Cancel open orders near endTime (requirement 11).
        // Fire once per market per window — the Set guard prevents the 1-second
        // loop from hammering the CLOB API with redundant cancel requests.
        const timeToEnd = market.endTime * 1000 - Date.now();
        if (
          timeToEnd < this.config.cancelBeforeEndTimeMs &&
          timeToEnd > 0 &&
          !this.cancelledMarketsBeforeExpiry.has(market.marketId)
        ) {
          this.cancelledMarketsBeforeExpiry.add(market.marketId);
          const tokenIds = [market.tokens.upTokenId, market.tokens.downTokenId];
          logWarn(
            `Market ${market.marketId} ending in ${Math.round(timeToEnd / 1000)}s — ` +
            `canceling all open orders to avoid post-resolution fills`,
          );
          // Fire-and-forget: cancellation is best-effort; errors are logged inside.
          this.executor.cancelOrdersForTokens(tokenIds).catch((error) => {
            logError(`Pre-expiry order cancel failed for market ${market.marketId}:`, error);
          });
        }

        // Resolve market after endTime (fetch finalFinishPrice and write to log)
        if (timeToEnd <= 0 && !this.resolvedMarkets.has(market.marketId)) {
          // Fire-and-forget; errors are logged inside resolveMarket.
          this.resolveMarket(market).catch((error) => {
            logError(`Failed to resolve market ${market.marketId}:`, error);
          });
        }
      }
    } catch (error) {
      logError("Error in monitoring loop:", error);
    }
  }

  /**
   * Fetch the final resolution for a market after its endTime and write it
   * to the JSON log so the simulator can score trades accurately.
   */
  private async resolveMarket(market: MarketData): Promise<void> {
    // Mark immediately to prevent duplicate concurrent resolve calls.
    this.resolvedMarkets.add(market.marketId);

    // Give Polymarket's oracle a few seconds to settle after endTime.
    const msSinceEnd = Date.now() - market.endTime * 1000;
    if (msSinceEnd < 5000) {
      await new Promise((r) => setTimeout(r, 5000 - msSinceEnd));
    }

    logInfo(`Fetching final resolution for market ${market.marketId} (${market.marketType})...`);

    try {
      const finalFinishPrice = await this.client.getFinalBtcPrice(market.endTime);
      if (finalFinishPrice === null) {
        logWarn(`Could not fetch final BTC price for market ${market.marketId} — will retry next tick`);
        this.resolvedMarkets.delete(market.marketId); // allow retry
        return;
      }

      // Determine result for this individual market based on whether BTC
      // finished above or below the beat price.
      const beatPrice = market.beatPrice?.value ?? 0;
      const result: "UP" | "DOWN" = finalFinishPrice > beatPrice ? "UP" : "DOWN";

      // Update in-memory market state
      market.finalFinishPrice = finalFinishPrice;
      market.result = result;

      logInfo(
        `Market ${market.marketId} (${market.marketType}) resolved: ` +
        `BTC=${finalFinishPrice} beat=${beatPrice} → ${result}`,
      );

      // Find the paired market so we can write both results to the JSON log.
      const otherType: "5m" | "15m" = market.marketType === "5m" ? "15m" : "5m";
      const pairedMarket = this.marketDataManager.getMarketsByType(otherType)
        .find((m) => m.endTime === market.endTime);

      if (pairedMarket) {
        // Also resolve the paired market if not done yet.
        if (pairedMarket.result === "PENDING") {
          const pairedResult: "UP" | "DOWN" = finalFinishPrice > (pairedMarket.beatPrice?.value ?? 0) ? "UP" : "DOWN";
          pairedMarket.finalFinishPrice = finalFinishPrice;
          pairedMarket.result = pairedResult;
          this.resolvedMarkets.add(pairedMarket.marketId);
          logInfo(
            `Market ${pairedMarket.marketId} (${pairedMarket.marketType}) resolved: ` +
            `BTC=${finalFinishPrice} beat=${pairedMarket.beatPrice?.value ?? 0} → ${pairedResult}`,
          );
        }

        const market5m  = market.marketType === "5m" ? market : pairedMarket;
        const market15m = market.marketType === "15m" ? market : pairedMarket;

        // Write finalResolution to the JSON log file.
        this.jsonLogger.logFinalResolution(
          market5m,
          market15m,
          finalFinishPrice,
          market5m.result as "UP" | "DOWN",
          market15m.result as "UP" | "DOWN",
        );

        logInfo(
          `JSON log updated with finalResolution: 5m=${market5m.result} 15m=${market15m.result} ` +
          `finishPrice=${finalFinishPrice}`,
        );
      } else {
        logWarn(
          `Could not find paired ${otherType} market for resolution logging ` +
          `(market ${market.marketId}, endTime ${market.endTime})`,
        );
      }

      // Persist resolution to database.
      await this.storeMarketData(market);
      if (pairedMarket) await this.storeMarketData(pairedMarket);

    } catch (error) {
      logError(`Error resolving market ${market.marketId}:`, error);
      // Allow retry on next monitoring tick.
      this.resolvedMarkets.delete(market.marketId);
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
   * Process synchronized markets for arbitrage.
   *
   * Re-entrancy guard: this method is called from both the 1-second monitoring
   * loop and the WebSocket onSyncDetected callback. Without the guard, dozens of
   * concurrent executions can fire before the first order settles, causing
   * duplicate trades for the same opportunity.
   */
  private async processSynchronizedMarkets(market5m: MarketData, market15m: MarketData): Promise<void> {
    if (this.isHalting) {
      logDebug("Arb check skipped — bot is halting after unwind failure");
      return;
    }
    if (this.isProcessingArb) {
      logDebug("Arb check skipped — previous execution still in flight");
      return;
    }
    this.isProcessingArb = true;
    try {
      await this._doProcessSynchronizedMarkets(market5m, market15m);
    } finally {
      this.isProcessingArb = false;
    }
  }

  private async _doProcessSynchronizedMarkets(market5m: MarketData, market15m: MarketData): Promise<void> {
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

      // Check risk controls BEFORE logging — prevents detected-but-blocked
      // events from being indistinguishable from executed trades in post-mortem.
      if (!this.checkRiskControls()) {
        logWarn("Risk controls triggered, skipping trade");
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

      // Execute trade (live) or record a paper trade (ENABLE_TRADING=false)
      await this.executeArbitrageTrade(market5m, market15m, opportunity);
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
      market5mId:  market5m.marketId,
      market15mId: market15m.marketId,
      upPrice: adjustedUpPrice,
      downPrice: adjustedDownPrice,
      quantity: this.config.defaultQuantity,
    };

    // ── Paper trade (ENABLE_TRADING=false) ───────────────────────────────────
    if (!this.config.enableTrading) {
      const sumPrice = adjustedUpPrice + adjustedDownPrice;
      const paperExecution: TradeExecution = {
        tradeId:      randomUUID(),
        timestamp:    Date.now(),
        market5Id:    market5m.marketId,
        market15Id:   market15m.marketId,
        direction:    { upMarket, downMarket },
        prices: {
          upPrice:  adjustedUpPrice,
          downPrice: adjustedDownPrice,
          sumPrice,
        },
        quantity:     this.config.defaultQuantity,
        latencyMs:    0,
        status:       "simulated",
        pnlEstimate:  1.0 - sumPrice,
      };
      logInfo(
        `[PAPER TRADE] case=${opportunity.case} ` +
        `sum=${sumPrice.toFixed(4)} ` +
        `pnl=${paperExecution.pnlEstimate.toFixed(4)} ` +
        `(up=${adjustedUpPrice.toFixed(4)} down=${adjustedDownPrice.toFixed(4)}) ` +
        `— recorded to DB, no real capital spent`,
      );
      await this.storeTradeRecord(market5m, market15m, paperExecution);
      this.jsonLogger.logTradeExecution(market5m, market15m, paperExecution);
      this.dailyTradeCount++;
      return;
    }

    // ── Live trade ────────────────────────────────────────────────────────────
    logInfo(`Executing arbitrage trade: ${opportunity.case}, sum=${opportunity.prices.sumPrice.toFixed(4)}`);

    try {
      const execution = await this.executor.executeTradeBatch(tradeParams);

      // Store trade record
      await this.storeTradeRecord(market5m, market15m, execution);
      this.jsonLogger.logTradeExecution(market5m, market15m, execution);
      this.dailyTradeCount++;
    } catch (error) {
      if (error instanceof UnwindFailedError) {
        // A naked position exists. Set isHalting FIRST — before the finally
        // block of processSynchronizedMarkets clears isProcessingArb — so the
        // monitoring loop cannot fire another trade while stop() is still running.
        this.isHalting = true;
        logError(
          `[CRITICAL] UNWIND FAILED — HALTING BOT IMMEDIATELY.\n${error.message}`,
        );
        try {
          await this.storeTradeRecord(market5m, market15m, error.partialExecution);
          this.jsonLogger.logTradeExecution(market5m, market15m, error.partialExecution);
        } catch (dbErr) {
          logError("Failed to persist unwind-failure record:", dbErr);
        }
        await sendCriticalAlert(
          `**UNWIND FAILED — bot halted. Naked position may exist.**\n\`\`\`\n${error.message}\n\`\`\`\n` +
          `Market 5m: ${market5m.marketId}\nMarket 15m: ${market15m.marketId}`,
        );
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
      beat_price: market.beatPrice?.value ?? null,
      beat_price_timestamp: market.beatPrice?.timestamp ?? null,
      final_finish_price: market.finalFinishPrice,
      result: market.result,
      price_timeline: market.priceHistory,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    await this.database.storeMarketData(marketRecord);
  }
}
