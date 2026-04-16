/**
 * Atomic trade execution system with Zero Naked Exposure guarantee.
 *
 * Core invariant: the bot will NEVER hold a single filled leg without the
 * other. If one leg fills and the other misses, unwindPosition() immediately
 * places an aggressive FAK SELL at UNWIND_SELL_PRICE ($0.01) to sweep the
 * entire bid side. We accept maximum slippage on the unwind; avoiding a
 * directional bet is the only priority.
 *
 * If the unwind itself fails, executeTradeBatch() throws UnwindFailedError.
 * The caller (ArbitrageOrchestrator) must catch this, persist the record, and
 * halt the bot. A naked position must never be silently ignored.
 */

import { randomUUID } from "crypto";
import type { TradeParams, TradeExecution, TradeStatus } from "../types";
import { logInfo, logError, logWarn, logDebug } from "../utils/logger";
import { getConfig } from "../config";
import { ClobClient } from "../clients/clob-client";

// The unwind sell price is hardcoded to the minimum valid tick ($0.01).
// At this price the FAK SELL order sweeps every bid in the book, guaranteeing
// a fill at whatever the market will pay. Do NOT use the original entry price:
// the bid-ask spread would cause an instant FOK/FAK kill with no fill.
const UNWIND_SELL_PRICE = 0.01;

function generateUUID(): string {
  return randomUUID();
}

/**
 * Thrown when an emergency unwind sell order fails to fill.
 * The bot MUST halt when this is caught — a live naked position exists that
 * requires manual resolution.
 */
export class UnwindFailedError extends Error {
  public readonly legName: string;
  public readonly tokenId: string;
  public readonly quantity: number;
  /** Attached so the orchestrator can persist a full trade record before halting. */
  public readonly partialExecution: TradeExecution;

  constructor(
    legName: string,
    tokenId: string,
    quantity: number,
    partialExecution: TradeExecution,
  ) {
    super(
      `CRITICAL: Unwind of ${legName} leg failed ` +
        `(token: ${tokenId.substring(0, 20)}..., qty: ${quantity}). ` +
        `Naked position exists — manual resolution required. Bot halting.`,
    );
    this.name = "UnwindFailedError";
    this.legName = legName;
    this.tokenId = tokenId;
    this.quantity = quantity;
    this.partialExecution = partialExecution;
  }
}

export class TradeExecutor {
  private config = getConfig();
  private clobClient: ClobClient;
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
   * Ensure wallet is approved (call before first trade).
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
   * Execute atomic arbitrage trade via the Polymarket batch orders endpoint.
   *
   * Submits both legs as FOK (Fill-Or-Kill) in a single HTTP call. Because
   * Polymarket's matching engine processes orders sequentially even in a batch,
   * atomicity is NOT guaranteed by the API. We enforce it ourselves:
   *
   *   Both filled      → status "filled"        (clean arbitrage win)
   *   Neither filled   → status "failed"        (clean miss, zero exposure)
   *   One filled only  → unwindPosition()       (FAK sell at $0.01 to sweep bids)
   *                      status "partial_unwind" on success
   *
   * @throws UnwindFailedError  if the emergency sell does not fill. The caller
   *   (ArbitrageOrchestrator) must catch this and halt the bot immediately.
   */
  async executeTradeBatch(params: TradeParams): Promise<TradeExecution> {
    const tradeId = generateUUID();
    const startTime = Date.now();

    logInfo(`[${tradeId}] Submitting batch FOK: UP(${params.upMarket}) / DOWN(${params.downMarket})`);

    if (!this.approvalDone) {
      await this.ensureApproved();
    }

    let upOrderId: string | undefined;
    let downOrderId: string | undefined;

    try {
      const results = await this.clobClient.placeBatchOrders([
        {
          tokenId: params.upTokenId,
          price: params.upPrice,
          size: params.quantity,
          side: "BUY",
          orderType: "FOK",
        },
        {
          tokenId: params.downTokenId,
          price: params.downPrice,
          size: params.quantity,
          side: "BUY",
          orderType: "FOK",
        },
      ]);

      const latency = Date.now() - startTime;

      // Batch response validation: a length mismatch (handled by placeBatchOrders)
      // returns error objects for all slots, so we always get exactly 2 entries.
      // Guard here as a belt-and-suspenders check.
      if (results.length !== 2) {
        logError(`[${tradeId}] Unexpected batch result count: ${results.length}; treating as failed`);
        return this.buildExecution(tradeId, params, latency, "failed", undefined, undefined,
          `Unexpected batch result count: ${results.length}`);
      }

      const upResult = results[0];
      const downResult = results[1];

      upOrderId = upResult?.orderID;
      downOrderId = downResult?.orderID;

      // A leg is filled only when the matching engine confirms "matched".
      // HTTP-200 with status "unmatched" means the FOK was killed — that is a
      // miss, not a success. We must never treat a kill as a fill.
      const upFilled = !upResult?.error && upResult?.status === "matched";
      const downFilled = !downResult?.error && downResult?.status === "matched";

      logDebug(
        `[${tradeId}] UP: ${upFilled ? "FILLED" : "MISSED"} ` +
          `(${upResult?.status ?? upResult?.error ?? "no response"}), ` +
          `DOWN: ${downFilled ? "FILLED" : "MISSED"} ` +
          `(${downResult?.status ?? downResult?.error ?? "no response"})`,
      );

      // ── Both legs filled ──────────────────────────────────────────────────
      if (upFilled && downFilled) {
        logInfo(`[${tradeId}] Both legs filled — clean arbitrage.`);
        return this.buildExecution(tradeId, params, latency, "filled", upOrderId, downOrderId,
          undefined, undefined, "matched", "matched");
      }

      // ── Neither leg filled ────────────────────────────────────────────────
      if (!upFilled && !downFilled) {
        const reason =
          `UP: ${upResult?.error ?? upResult?.status ?? "unmatched"}, ` +
          `DOWN: ${downResult?.error ?? downResult?.status ?? "unmatched"}`;
        logInfo(`[${tradeId}] Neither leg filled — clean miss. ${reason}`);
        return this.buildExecution(tradeId, params, latency, "failed", upOrderId, downOrderId, reason,
          undefined, upResult?.status ?? "unmatched", downResult?.status ?? "unmatched");
      }

      // ── Partial fill — one leg filled, one missed ─────────────────────────
      const filledLegName = upFilled ? "UP" : "DOWN";
      const filledTokenId = upFilled ? params.upTokenId : params.downTokenId;
      const missedLegName = upFilled ? "DOWN" : "UP";

      logWarn(
        `[${tradeId}] PARTIAL FILL DETECTED: ${filledLegName} leg filled, ` +
          `${missedLegName} leg missed. Initiating emergency unwind.`,
      );

      const unwindResult = await this.unwindPosition(filledLegName, filledTokenId, params.quantity, tradeId);

      if (!unwindResult.success) {
        // Build the execution record so the orchestrator can persist it before halting.
        const failedExecution = this.buildExecution(
          tradeId,
          params,
          Date.now() - startTime,
          "partial_unwind",
          upOrderId,
          downOrderId,
          `${filledLegName} leg filled; ${missedLegName} missed; UNWIND FAILED: ${unwindResult.error}`,
        );
        throw new UnwindFailedError(filledLegName, filledTokenId, params.quantity, failedExecution);
      }

      logInfo(`[${tradeId}] Unwind successful (sell order: ${unwindResult.orderId}). Position closed.`);

      return this.buildExecution(
        tradeId,
        params,
        Date.now() - startTime,
        "partial_unwind",
        upOrderId,
        downOrderId,
        `${filledLegName} filled; ${missedLegName} missed FOK; position unwound via sell ${unwindResult.orderId}.`,
        unwindResult.orderId,
      );
    } catch (error) {
      // Re-throw UnwindFailedError — orchestrator must catch and halt.
      if (error instanceof UnwindFailedError) {
        throw error;
      }

      const latency = Date.now() - startTime;
      logError(`[${tradeId}] Unexpected error during batch execution:`, error);
      return this.buildExecution(
        tradeId,
        params,
        latency,
        "failed",
        upOrderId,
        downOrderId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Emergency unwind: eliminate a naked position by selling the filled leg.
   *
   * Places a FAK SELL at UNWIND_SELL_PRICE ($0.01). This price is deliberately
   * below any realistic bid so the order sweeps the entire book and guarantees
   * a fill. We accept full market impact; removing the position is the only
   * priority.
   *
   * Returns a result object rather than throwing so the caller can attach the
   * partial execution record to UnwindFailedError before re-throwing.
   */
  private async unwindPosition(
    legName: string,
    tokenId: string,
    quantity: number,
    tradeId: string,
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    logWarn(
      `[${tradeId}] UNWIND: FAK SELL ${legName} ` +
        `(token: ${tokenId.substring(0, 20)}..., qty: ${quantity}, price: ${UNWIND_SELL_PRICE})`,
    );

    let response;
    try {
      response = await this.clobClient.placeSellOrder(tokenId, UNWIND_SELL_PRICE, quantity, "FAK");
    } catch (err) {
      return {
        success: false,
        error: `placeSellOrder threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (response.error || !response.orderID) {
      return {
        success: false,
        error: response.error ?? "No orderID returned from sell endpoint",
      };
    }

    // A FAK SELL at $0.01 should match against all bids in any liquid market.
    // If the status is not "matched", there are genuinely no bids — halt required.
    // Use case-insensitive comparison to guard against API casing drift.
    if (response.status?.toLowerCase() !== "matched") {
      return {
        success: false,
        orderId: response.orderID,
        error: `Sell order ${response.orderID} returned status "${response.status}" (expected "matched")`,
      };
    }

    return { success: true, orderId: response.orderID };
  }

  /**
   * Build a TradeExecution result object.
   */
  private buildExecution(
    tradeId: string,
    params: TradeParams,
    latencyMs: number,
    status: TradeStatus,
    upOrderId?: string,
    downOrderId?: string,
    error?: string,
    unwindOrderId?: string,
    upLegStatus?: string,
    downLegStatus?: string,
  ): TradeExecution {
    const sumPrice = params.upPrice + params.downPrice;
    const pnlEstimate = 1.0 - sumPrice;

    return {
      tradeId,
      timestamp: Date.now(),
      market5Id:  params.market5mId,
      market15Id: params.market15mId,
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
      latencyMs,
      status,
      upOrderId,
      downOrderId,
      // Per-leg statuses reflect individual API outcomes, not the overall trade status
      upOrderStatus: upLegStatus ?? status,
      downOrderStatus: downLegStatus ?? status,
      unwindOrderId,
      error,
      pnlEstimate,
    };
  }

  /**
   * Cancel all open orders whose tokenId matches one of the supplied token IDs.
   *
   * Called by the orchestrator's pre-expiry sweep to ensure no orders remain live
   * when a market approaches settlement — preventing fills from toxic post-resolution
   * flow. Returns the number of orders successfully canceled.
   */
  async cancelOrdersForTokens(tokenIds: string[]): Promise<number> {
    if (tokenIds.length === 0) return 0;
    const tokenIdSet = new Set(tokenIds);

    try {
      const openOrders = await this.clobClient.getOpenOrders();
      const relevant = openOrders.filter((o) => tokenIdSet.has(o.tokenId));

      if (relevant.length === 0) {
        logDebug(`No open orders found for token(s): ${tokenIds.join(", ")}`);
        return 0;
      }

      logInfo(`Canceling ${relevant.length} open order(s) for token(s): ${tokenIds.join(", ")}`);

      let canceled = 0;
      for (const order of relevant) {
        const ok = await this.clobClient.cancelOrder(order.orderID);
        if (ok) {
          canceled++;
          logDebug(`Canceled order ${order.orderID}`);
        } else {
          logWarn(`Failed to cancel order ${order.orderID} (token: ${order.tokenId})`);
        }
      }

      logInfo(`Pre-expiry sweep: canceled ${canceled}/${relevant.length} order(s)`);
      return canceled;
    } catch (error) {
      logError("cancelOrdersForTokens failed:", error);
      return 0;
    }
  }
}
