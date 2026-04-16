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
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${Math.random().toString(36).substr(2, 9)}`;
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
        return this.buildExecution(tradeId, params, latency, "filled", upOrderId, downOrderId);
      }

      // ── Neither leg filled ────────────────────────────────────────────────
      if (!upFilled && !downFilled) {
        const reason =
          `UP: ${upResult?.error ?? upResult?.status ?? "unmatched"}, ` +
          `DOWN: ${downResult?.error ?? downResult?.status ?? "unmatched"}`;
        logInfo(`[${tradeId}] Neither leg filled — clean miss. ${reason}`);
        return this.buildExecution(tradeId, params, latency, "failed", upOrderId, downOrderId, reason);
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
    if (response.status !== "matched" && response.status !== "MATCHED") {
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
  ): TradeExecution {
    const sumPrice = params.upPrice + params.downPrice;
    const pnlEstimate = 1.0 - sumPrice;

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
      latencyMs,
      status,
      upOrderId,
      downOrderId,
      upOrderStatus: status,
      downOrderStatus: status,
      unwindOrderId,
      error,
      pnlEstimate,
    };
  }
}
