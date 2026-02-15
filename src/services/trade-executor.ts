/**
 * Atomic trade execution system with parallel orders and timeout
 * Requirement: ≤50ms fill timeout, cancel other order if one fails
 * Implements EOA wallet approval and actual CLOB order placement
 */

import type { TradeParams, TradeExecution, TradeStatus } from "../types";
import { logInfo, logError, logWarn, logDebug } from "../utils/logger";
import { getConfig } from "../config";
import { ClobClient } from "../clients/clob-client";

// Simple UUID generator
function generateUUID(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${Math.random().toString(36).substr(2, 9)}`;
}

interface OrderResult {
  success: boolean;
  orderId?: string;
  status?: string;
  error?: string;
  filled?: boolean;
}

export class TradeExecutor {
  private config = getConfig();
  private clobClient: ClobClient;
  private pendingOrders: Map<string, { cancel: () => Promise<void> }> = new Map();
  private approvalDone = false;

  constructor() {
    try {
      this.clobClient = new ClobClient();
    } catch (error) {
      logError("Failed to initialize CLOB client:", error);
      throw error;
    }
  }

  /**
   * Ensure wallet is approved (call before first trade)
   */
  async ensureApproved(): Promise<boolean> {
    if (this.approvalDone) {
      return true;
    }

    logInfo("Ensuring wallet approval...");
    const success = await this.clobClient.approve();
    if (success) {
      this.approvalDone = true;
    }
    return success;
  }

  /**
   * Execute atomic arbitrage trade (requirement 6)
   * Submits both orders in parallel with ≤50ms timeout
   */
  async executeTrade(params: TradeParams): Promise<TradeExecution> {
    const tradeId = generateUUID();
    const startTime = Date.now();

    logInfo(`Executing trade ${tradeId}: UP in ${params.upMarket}, DOWN in ${params.downMarket}`);

    // Execute both orders in parallel
    const [upResult, downResult] = await Promise.allSettled([
      this.executeOrder(
        params.upTokenId,
        params.upPrice,
        params.quantity,
        params.orderType,
        params.limitPrice,
      ),
      this.executeOrder(
        params.downTokenId,
        params.downPrice,
        params.quantity,
        params.orderType,
        params.limitPrice,
      ),
    ]);

    const latency = Date.now() - startTime;

    // Check timeout
    if (latency > this.config.executionTimeoutMs) {
      logWarn(`Trade ${tradeId} exceeded timeout: ${latency}ms > ${this.config.executionTimeoutMs}ms`);
      // Cancel both orders if still pending
      await this.cancelBothOrders(upResult, downResult);
      return this.createTradeExecution(
        tradeId,
        params,
        latency,
        "failed",
        undefined,
        undefined,
        "Execution timeout exceeded",
      );
    }

    // Process results
    const upOrderResult =
      upResult.status === "fulfilled" ? upResult.value : { success: false, error: "Promise rejected" };
    const downOrderResult =
      downResult.status === "fulfilled"
        ? downResult.value
        : { success: false, error: "Promise rejected" };

    // If one order fails, cancel the other (requirement 6)
    if (!upOrderResult.success && downOrderResult.success) {
      logWarn(`UP order failed, canceling DOWN order`);
      if (downOrderResult.orderId) {
        await this.cancelOrder(downOrderResult.orderId);
      }
      return this.createTradeExecution(
        tradeId,
        params,
        latency,
        "failed",
        upOrderResult.orderId,
        downOrderResult.orderId,
        `UP order failed: ${upOrderResult.error || "unknown"}`,
      );
    }

    if (upOrderResult.success && !downOrderResult.success) {
      logWarn(`DOWN order failed, canceling UP order`);
      if (upOrderResult.orderId) {
        await this.cancelOrder(upOrderResult.orderId);
      }
      return this.createTradeExecution(
        tradeId,
        params,
        latency,
        "failed",
        upOrderResult.orderId,
        downOrderResult.orderId,
        `DOWN order failed: ${downOrderResult.error || "unknown"}`,
      );
    }

    if (!upOrderResult.success && !downOrderResult.success) {
      return this.createTradeExecution(
        tradeId,
        params,
        latency,
        "failed",
        upOrderResult.orderId,
        downOrderResult.orderId,
        `Both orders failed: UP=${upOrderResult.error || "unknown"}, DOWN=${downOrderResult.error || "unknown"}`,
      );
    }

    // Both orders succeeded
    const status: TradeStatus = upOrderResult.filled && downOrderResult.filled ? "filled" : "pending";

    return this.createTradeExecution(
      tradeId,
      params,
      latency,
      status,
      upOrderResult.orderId,
      downOrderResult.orderId,
      undefined,
    );
  }

  /**
   * Execute a single order using CLOB API
   */
  private async executeOrder(
    tokenId: string,
    price: number,
    quantity: number,
    orderType: "market" | "limit",
    limitPrice?: number,
  ): Promise<OrderResult> {
    try {
      // Ensure approval is done
      if (!this.approvalDone) {
        await this.ensureApproved();
      }

      const executionPrice = orderType === "market" ? price : (limitPrice || price);
      logDebug(`Executing ${orderType} order: token=${tokenId.substring(0, 20)}..., price=${executionPrice}, qty=${quantity}`);

      // Place order via CLOB API (FOK for immediate execution)
      // According to Polymarket docs: FOK orders must fill completely or are cancelled
      const response = await this.clobClient.placeBuyOrder(
        tokenId,
        executionPrice,
        quantity,
        "FOK", // Fill or Kill for atomic execution
      );

      if (response.error) {
        return {
          success: false,
          error: response.error,
        };
      }

      // Check if order was filled immediately (FOK orders either fill or fail)
      // Status can be: "matched", "live", "delayed", "unmatched" per Polymarket docs
      const isFilled = response.status === "matched" || response.status === "MATCHED";

      return {
        success: true,
        orderId: response.orderID,
        status: response.status || (isFilled ? "matched" : "unmatched"),
        filled: isFilled,
      };
    } catch (error) {
      logError(`Order execution error:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute both orders atomically using batch orders endpoint
   * According to https://docs.polymarket.com/developers/CLOB/orders/create-order-batch
   * This is better for atomic execution than placing orders separately
   */
  async executeTradeBatch(params: TradeParams): Promise<TradeExecution> {
    const tradeId = generateUUID();
    const startTime = Date.now();

    logInfo(`Executing batch trade ${tradeId}: UP in ${params.upMarket}, DOWN in ${params.downMarket}`);

    try {
      // Ensure approval is done
      if (!this.approvalDone) {
        await this.ensureApproved();
      }

      // Create batch order request
      const orderType: "FOK" | "FAK" | "GTC" | "GTD" = params.orderType === "market" ? "FOK" : "GTC";
      const orders = [
        {
          tokenId: params.upTokenId,
          price: params.upPrice,
          size: params.quantity,
          side: "BUY" as const,
          orderType,
        },
        {
          tokenId: params.downTokenId,
          price: params.downPrice,
          size: params.quantity,
          side: "BUY" as const,
          orderType,
        },
      ];

      // Place batch orders
      const results = await this.clobClient.placeBatchOrders(orders);
      const latency = Date.now() - startTime;

      // Check timeout
      if (latency > this.config.executionTimeoutMs) {
        logWarn(`Trade ${tradeId} exceeded timeout: ${latency}ms > ${this.config.executionTimeoutMs}ms`);
        // Cancel both orders if they were placed
        for (const result of results) {
          if (result.orderID) {
            await this.cancelOrder(result.orderID);
          }
        }
        return this.createTradeExecution(
          tradeId,
          params,
          latency,
          "failed",
          results[0]?.orderID,
          results[1]?.orderID,
          "Execution timeout exceeded",
        );
      }

      // Process results
      const upResult = results[0];
      const downResult = results[1];

      // If one order fails, cancel the other
      if (upResult.error && !downResult.error) {
        logWarn(`UP order failed, canceling DOWN order`);
        if (downResult.orderID) {
          await this.cancelOrder(downResult.orderID);
        }
        return this.createTradeExecution(
          tradeId,
          params,
          latency,
          "failed",
          upResult.orderID,
          downResult.orderID,
          `UP order failed: ${upResult.error}`,
        );
      }

      if (!upResult.error && downResult.error) {
        logWarn(`DOWN order failed, canceling UP order`);
        if (upResult.orderID) {
          await this.cancelOrder(upResult.orderID);
        }
        return this.createTradeExecution(
          tradeId,
          params,
          latency,
          "failed",
          upResult.orderID,
          downResult.orderID,
          `DOWN order failed: ${downResult.error}`,
        );
      }

      if (upResult.error && downResult.error) {
        return this.createTradeExecution(
          tradeId,
          params,
          latency,
          "failed",
          upResult.orderID,
          downResult.orderID,
          `Both orders failed: UP=${upResult.error}, DOWN=${downResult.error}`,
        );
      }

      // Both orders succeeded
      const upFilled = upResult.status === "matched";
      const downFilled = downResult.status === "matched";
      const status: TradeStatus = upFilled && downFilled ? "filled" : "pending";

      return this.createTradeExecution(
        tradeId,
        params,
        latency,
        status,
        upResult.orderID,
        downResult.orderID,
        undefined,
      );
    } catch (error) {
      const latency = Date.now() - startTime;
      logError(`Batch trade execution error:`, error);
      return this.createTradeExecution(
        tradeId,
        params,
        latency,
        "failed",
        undefined,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Cancel an order via CLOB API
   */
  private async cancelOrder(orderId: string): Promise<void> {
    try {
      logDebug(`Canceling order: ${orderId}`);
      const success = await this.clobClient.cancelOrder(orderId);
      if (success) {
        logInfo(`Order ${orderId} canceled successfully`);
      } else {
        logWarn(`Failed to cancel order ${orderId}`);
      }
      this.pendingOrders.delete(orderId);
    } catch (error) {
      logError(`Failed to cancel order ${orderId}:`, error);
    }
  }

  /**
   * Cancel both orders if needed
   */
  private async cancelBothOrders(
    upResult: PromiseSettledResult<OrderResult>,
    downResult: PromiseSettledResult<OrderResult>,
  ): Promise<void> {
    const upOrderId =
      upResult.status === "fulfilled" && upResult.value.success ? upResult.value.orderId : undefined;
    const downOrderId =
      downResult.status === "fulfilled" && downResult.value.success
        ? downResult.value.orderId
        : undefined;

    await Promise.all([
      upOrderId ? this.cancelOrder(upOrderId) : Promise.resolve(),
      downOrderId ? this.cancelOrder(downOrderId) : Promise.resolve(),
    ]);
  }

  /**
   * Create trade execution result
   */
  private createTradeExecution(
    tradeId: string,
    params: TradeParams,
    latency: number,
    status: TradeStatus,
    upOrderId?: string,
    downOrderId?: string,
    error?: string,
  ): TradeExecution {
    const sumPrice = params.upPrice + params.downPrice;
    const pnlEstimate = 1.0 - sumPrice; // Expected payout is 1.0, cost is sumPrice

    return {
      tradeId,
      timestamp: Date.now(),
      market5Id: params.upMarket === "5m" ? params.upTokenId : params.downTokenId,
      market15Id: params.upMarket === "15m" ? params.upTokenId : params.downTokenId,
      direction: {
        upMarket: params.upMarket,
        downMarket: params.downMarket,
      },
      prices: {
        upPrice: params.upPrice,
        downPrice: params.downPrice,
        sumPrice,
      },
      quantity: params.quantity,
      latencyMs: latency,
      status,
      upOrderId,
      downOrderId,
      upOrderStatus: status === "filled" ? "filled" : status,
      downOrderStatus: status === "filled" ? "filled" : status,
      error,
      pnlEstimate,
    };
  }
}
