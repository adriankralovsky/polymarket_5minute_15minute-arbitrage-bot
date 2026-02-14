/**
 * Enhanced logger for arbitrage bot with sync detection logging
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

let currentLogLevel: LogLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel | string): void {
  if (typeof level === "string") {
    const levelMap: Record<string, LogLevel> = {
      debug: LogLevel.DEBUG,
      info: LogLevel.INFO,
      warn: LogLevel.WARN,
      error: LogLevel.ERROR,
    };
    currentLogLevel = levelMap[level.toLowerCase()] || LogLevel.INFO;
  } else {
    currentLogLevel = level;
  }
}

function formatTimestamp(): string {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

function log(level: LogLevel, levelName: string, ...args: unknown[]): void {
  if (level >= currentLogLevel) {
    console.log(`[${formatTimestamp()}] [${levelName}]`, ...args);
  }
}

export function logDebug(...args: unknown[]): void {
  log(LogLevel.DEBUG, "DEBUG", ...args);
}

export function logInfo(...args: unknown[]): void {
  log(LogLevel.INFO, "INFO", ...args);
}

export function logWarn(...args: unknown[]): void {
  log(LogLevel.WARN, "WARN", ...args);
}

export function logError(...args: unknown[]): void {
  log(LogLevel.ERROR, "ERROR", ...args);
}

/**
 * Log synchronized market detection (requirement 9.1)
 */
export function logSyncDetected(
  direction: { upMarket: "5m" | "15m"; downMarket: "5m" | "15m" },
  prices: { upPrice: number; downPrice: number },
  sumPrice: number,
  timestamp: number,
): void {
  const directionStr = `BUY UP in ${direction.upMarket} / BUY DOWN in ${direction.downMarket}`;
  console.log("\n" + "=".repeat(80));
  console.log("[SYNC DETECTED]");
  console.log(`Direction: ${directionStr}`);
  console.log(`Prices: up=${prices.upPrice.toFixed(4)}, down=${prices.downPrice.toFixed(4)}`);
  console.log(`Sum: ${sumPrice.toFixed(4)}`);
  console.log(`Timestamp: ${new Date(timestamp).toISOString()}`);
  console.log("=".repeat(80) + "\n");
}

// Initialize from environment
if (process.env.LOG_LEVEL) {
  setLogLevel(process.env.LOG_LEVEL);
}
