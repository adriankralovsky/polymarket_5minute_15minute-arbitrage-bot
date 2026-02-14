/**
 * Atomic trade execution system with parallel orders and timeout
 * Requirement: ≤50ms fill timeout, cancel other order if one fails
 */

import type { TradeParams, TradeExecution, TradeStatus } from "../types";
import { logInfo, logError, logWarn, logDebug } from "../utils/logger";
import { getConfig } from "../config";
// Simple UUID generator (in production, use uuid package)
function generateUUID(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${Math.random().toString(36).substr(2, 9)}`;
}

// Note: This is a placeholder structure. In production, you would use
// @polymarket/clob-client or similar for actual order execution
interface OrderResult {
  success: boolean;
  orderId?: string;
  status?: string;
  error?: string;
  filled?: boolean;
}

export class TradeExecutor {
  private config = getConfig();
  private pendingOrders: Map<string, { cancel: () => Promise<void> }> = new Map();

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
   * Execute a single order
   */
  private async executeOrder(
    tokenId: string,
    price: number,
    quantity: number,
    orderType: "market" | "limit",
    limitPrice?: number,
  ): Promise<OrderResult> {
    try {
      // TODO: Implement actual order execution using CLOB client
      // This is a placeholder that simulates order execution
      logDebug(`Executing ${orderType} order: token=${tokenId}, price=${price}, qty=${quantity}`);

      // Simulate API call delay
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 20));

      // Simulate success/failure
      const success = Math.random() > 0.1; // 90% success rate

      if (success) {
        return {
          success: true,
          orderId: `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          status: orderType === "market" ? "filled" : "open",
          filled: orderType === "market",
        };
      } else {
        return {
          success: false,
          error: "Simulated order failure",
        };
      }
    } catch (error) {
      logError(`Order execution error:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Cancel an order
   */
  private async cancelOrder(orderId: string): Promise<void> {
    try {
      logDebug(`Canceling order: ${orderId}`);
      // TODO: Implement actual order cancellation
      const cancelFn = this.pendingOrders.get(orderId);
      if (cancelFn) {
        await cancelFn.cancel();
        this.pendingOrders.delete(orderId);
      }
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
