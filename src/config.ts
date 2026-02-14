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
}

const defaultConfig: Config = {
  arbThreshold: parseFloat(process.env.ARB_THRESHOLD || "0.9"),
  slippageBuffer: parseFloat(process.env.SLIPPAGE_BUFFER || "0.05"),
  maxSlippage: parseFloat(process.env.MAX_SLIPPAGE || "0.02"),
  executionTimeoutMs: parseInt(process.env.EXECUTION_TIMEOUT_MS || "50"),
  maxLatencyMs: parseInt(process.env.MAX_LATENCY_MS || "100"),
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017",
  mongoDbName: process.env.MONGO_DB_NAME || "btc_arbitrage",
  wsReconnectDelayMs: parseInt(process.env.WS_RECONNECT_DELAY_MS || "5000"),
  wsHeartbeatIntervalMs: parseInt(process.env.WS_HEARTBEAT_INTERVAL_MS || "30000"),
  maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || "1000"),
  maxDailyTrades: parseInt(process.env.MAX_DAILY_TRADES || "100"),
  logDir: process.env.LOG_DIR || "./logs",
  enableJsonLogs: process.env.ENABLE_JSON_LOGS !== "0",
  enableTrading: process.env.ENABLE_TRADING === "1",
  defaultQuantity: parseFloat(process.env.DEFAULT_QUANTITY || "10"),
  maxDataAgeMs: parseInt(process.env.MAX_DATA_AGE_MS || "5000"),
  cancelBeforeEndTimeMs: parseInt(process.env.CANCEL_BEFORE_END_TIME_MS || "10000"),
};

export function getConfig(): Config {
  return { ...defaultConfig };
}
