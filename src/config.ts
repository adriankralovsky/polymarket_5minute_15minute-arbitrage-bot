/**
 * Configuration for BTC 5-15 minute arbitrage bot
 */

export interface Config {
  // Arbitrage threshold (default 0.9)
  arbThreshold: number;
  // Slippage buffer for near-threshold trades
  slippageBuffer: number;
  // Maximum allowed slippage for limit orders
  maxSlippage: number;
  // Trade execution timeout (ms)
  executionTimeoutMs: number;
  // Maximum latency before canceling (ms)
  maxLatencyMs: number;
  // MongoDB connection
  mongoUri: string;
  mongoDbName: string;
  // WebSocket settings
  wsReconnectDelayMs: number;
  wsHeartbeatIntervalMs: number;
  // Risk controls
  maxPositionSize: number;
  maxDailyTrades: number;
  // Logging
  logDir: string;
  enableJsonLogs: boolean;
  // Trading
  enableTrading: boolean;
  defaultQuantity: number;
  // Stale data protection
  maxDataAgeMs: number;
  // Cancel orders near endTime
  cancelBeforeEndTimeMs: number;
  // Polygon RPC URL
  polygonRpcUrl: string;
  // Volatility filter: abort trade if UP or DOWN price range over the 60-entry
  // history window exceeds this value (e.g. 0.05 = 5¢ swing in ~30 seconds)
  maxPriceVolatility: number;
  // Minimum history entries required before the volatility/slippage filters
  // activate — prevents false positives on bot startup when history is thin
  minHistoryForFilter: number;
}

const defaultConfig: Config = {
  arbThreshold: parseFloat(process.env.ARB_THRESHOLD || "0.9"),
  slippageBuffer: parseFloat(process.env.SLIPPAGE_BUFFER || "0.05"),
  maxSlippage: parseFloat(process.env.MAX_SLIPPAGE || "0.02"),
  // 5000ms is the safe default — 50ms is shorter than a typical Polygon RPC
  // round-trip and will cause 100% timeout failures on a normal connection.
  // Lower this only if you have confirmed sub-50ms RPC latency.
  executionTimeoutMs: parseInt(process.env.EXECUTION_TIMEOUT_MS || "5000", 10),
  maxLatencyMs: parseInt(process.env.MAX_LATENCY_MS || "100", 10),
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017",
  mongoDbName: process.env.MONGO_DB_NAME || "btc_arbitrage",
  wsReconnectDelayMs: parseInt(process.env.WS_RECONNECT_DELAY_MS || "5000", 10),
  wsHeartbeatIntervalMs: parseInt(process.env.WS_HEARTBEAT_INTERVAL_MS || "30000", 10),
  maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || "1000"),
  maxDailyTrades: parseInt(process.env.MAX_DAILY_TRADES || "100", 10),
  logDir: process.env.LOG_DIR || "./logs",
  enableJsonLogs: process.env.ENABLE_JSON_LOGS !== "0",
  enableTrading: process.env.ENABLE_TRADING === "1",
  defaultQuantity: parseFloat(process.env.DEFAULT_QUANTITY || "10"),
  maxDataAgeMs: parseInt(process.env.MAX_DATA_AGE_MS || "5000", 10),
  cancelBeforeEndTimeMs: parseInt(process.env.CANCEL_BEFORE_END_TIME_MS || "10000", 10),
  polygonRpcUrl: process.env.POLY_RPC_URL || "https://polygon-rpc.com",
  maxPriceVolatility: parseFloat(process.env.MAX_PRICE_VOLATILITY || "0.05"),
  // 30 snapshots ≈ 15 seconds at 2 ticks/sec — enough history for a meaningful
  // volatility window. 10 (5 seconds) is too short; filters activate almost immediately.
  minHistoryForFilter: parseInt(process.env.MIN_HISTORY_FOR_FILTER || "30", 10),
};

/**
 * Validate that all numeric config fields parsed correctly.
 * An empty or non-numeric env var produces NaN, which silently makes every
 * comparison (e.g. sumPrice < arbThreshold) always false — the bot runs but
 * never trades, with no error logged.
 */
function validateConfig(cfg: Config): void {
  const numericFields: Array<keyof Config> = [
    "arbThreshold", "slippageBuffer", "maxSlippage", "executionTimeoutMs",
    "maxLatencyMs", "wsReconnectDelayMs", "wsHeartbeatIntervalMs",
    "maxPositionSize", "maxDailyTrades", "defaultQuantity", "maxDataAgeMs",
    "cancelBeforeEndTimeMs", "maxPriceVolatility", "minHistoryForFilter",
  ];
  for (const field of numericFields) {
    if (typeof cfg[field] === "number" && isNaN(cfg[field] as number)) {
      throw new Error(
        `Invalid config: ${field} is NaN. ` +
        `Check your .env — the variable may be set to an empty or non-numeric value.`,
      );
    }
  }
}

export function getConfig(): Config {
  const cfg = { ...defaultConfig };
  validateConfig(cfg);
  return cfg;
}
