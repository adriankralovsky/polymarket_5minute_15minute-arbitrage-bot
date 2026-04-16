/**
 * Type definitions for BTC 5-15 minute arbitrage bot
 */

export type MarketType = "5m" | "15m";
export type TokenSide = "up" | "down";
export type TradeStatus = "filled" | "canceled" | "failed" | "pending" | "partial_unwind" | "simulated";
export type MarketResult = "UP" | "DOWN" | "PENDING";

/**
 * Beat Price - Critical concept
 * Fixed target BTC price used only to determine final market outcome at endTime
 * NOT a trading price, bid/ask, or fair value
 */
export interface BeatPrice {
  value: number;
  timestamp: number; // Market start timestamp
  source: "coingecko" | "polymarket" | "calculated" | "gamma-api" | "gamma-api-prev-finalPrice" | "binance-fallback";
}

/**
 * Market data with beat price and resolution info
 */
export interface MarketData {
  marketId: string;
  marketType: MarketType;
  eventId: string;
  slug: string;
  startTime: number; // Unix timestamp
  endTime: number; // Unix timestamp
  beatPrice: BeatPrice | null;
  tokens: {
    upTokenId: string;
    downTokenId: string;
  };
  // Executable prices (best ask for buying)
  upPrice: number | null;
  downPrice: number | null;
  // Liquidity info
  upLiquidity: number;
  downLiquidity: number;
  // Resolution data (after endTime)
  finalFinishPrice: number | null;
  result: MarketResult;
  // Price timeline for logging
  priceHistory: PriceSnapshot[];
}

export interface PriceSnapshot {
  timestamp: number;
  upPrice: number | null;
  downPrice: number | null;
  source: "websocket" | "rest";
}

/**
 * Order book level
 */
export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

/**
 * Arbitrage opportunity detection result
 */
export interface ArbitrageOpportunity {
  exists: boolean;
  case: "A" | "B" | "C" | null;
  direction: {
    upMarket: MarketType;
    downMarket: MarketType;
  } | null;
  prices: {
    upPrice: number;
    downPrice: number;
    sumPrice: number;
  } | null;
  beatPrices: {
    beat5m: number;
    beat15m: number;
  } | null;
  endTime: number | null;
  timestamp: number;
  reason?: string;
}

/**
 * Trade execution parameters
 */
export interface TradeParams {
  upTokenId: string;
  downTokenId: string;
  upMarket: MarketType;
  downMarket: MarketType;
  /** Actual market IDs (not token IDs) for trade-record labelling. */
  market5mId: string;
  market15mId: string;
  upPrice: number;
  downPrice: number;
  quantity: number;
}

/**
 * Trade execution result
 */
export interface TradeExecution {
  tradeId: string;
  timestamp: number;
  market5Id: string;
  market15Id: string;
  direction: {
    upMarket: MarketType;
    downMarket: MarketType;
  };
  prices: {
    upPrice: number;
    downPrice: number;
    sumPrice: number;
  };
  quantity: number;
  latencyMs: number;
  status: TradeStatus;
  upOrderId?: string;
  downOrderId?: string;
  upOrderStatus?: string;
  downOrderStatus?: string;
  unwindOrderId?: string;
  error?: string;
  pnlEstimate: number;
}

/**
 * MongoDB document schemas
 */
export interface TradeRecord {
  _id?: string;
  timestamp: number;
  market5_id: string;
  market15_id: string;
  direction: {
    upMarket: MarketType;
    downMarket: MarketType;
  };
  price_up: number;
  price_down: number;
  sum_price: number;
  quantity: number;
  latency_ms: number;
  status: TradeStatus;
  up_order_id?: string;
  down_order_id?: string;
  pnl_estimate: number;
  error?: string;
}

export interface MarketDataRecord {
  _id?: string;
  market_id: string;
  market_type: MarketType;
  event_id: string;
  slug: string;
  start_time: number;
  end_time: number;
  beat_price: number | null;
  beat_price_timestamp: number | null;
  final_finish_price: number | null;
  result: MarketResult;
  price_timeline: PriceSnapshot[];
  created_at: number;
  updated_at: number;
}

/**
 * WebSocket message types
 */
export interface WebSocketMessage {
  type: string;
  channel?: string;
  data?: unknown;
}

export interface PriceUpdateMessage {
  tokenId: string;
  price: string;
  timestamp: number;
}

export interface OrderBookUpdateMessage {
  tokenId: string;
  orderbook: OrderBook;
  timestamp: number;
}

/**
 * Simulation/backtesting types
 */
export interface HistoricalMarketData {
  marketId: string;
  marketType: MarketType;
  startTime: number;
  endTime: number;
  beatPrice: number;
  priceTimeline: PriceSnapshot[];
  finalFinishPrice: number;
  result: MarketResult;
}

export interface SimulationResult {
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  /** Trades where the market result was still PENDING — excluded from PnL. */
  unresolvedTrades: number;
  winRate: number;
  totalPnL: number;
  pnlCurve: Array<{ timestamp: number; cumulativePnL: number }>;
  maxDrawdown: number;
  latencySensitivity: Array<{ latencyMs: number; successRate: number }>;
}
