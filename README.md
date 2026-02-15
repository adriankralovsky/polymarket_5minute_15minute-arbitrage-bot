# BTC 5-15 Minute Arbitrage Bot

Production-grade BTC binary prediction market arbitrage bot for Polymarket.

## Overview

This bot monitors BTC 5-minute and 15-minute binary prediction markets and executes arbitrage trades when synchronized markets (same `endTime`) are detected.

## Critical Concept: Beat Price

**Beat Price** is a fixed target BTC price used only to determine the final market outcome at `endTime`. It is:
- **NOT** a trading price, bid/ask, order-book best price, last traded price, or fair value
- A resolution threshold, similar to a binary option strike

### Resolution Rule

At `endTime`:
- `finish_price > beat_price` → UP token wins (payout = 1.0)
- `finish_price < beat_price` → DOWN token wins (payout = 1.0)

## Arbitrage Strategy

The bot evaluates arbitrage only when `endTime_5m == endTime_15m` (both markets resolve using the same BTC finish price).

### Case A: `beatPrice_15m > beatPrice_5m`
- Trade: BUY UP in 5m, BUY DOWN in 15m
- Execute if: `price_up_5m + price_down_15m < ARB_THRESHOLD`

### Case B: `beatPrice_5m > beatPrice_15m`
- Trade: BUY UP in 15m, BUY DOWN in 5m
- Execute if: `price_up_15m + price_down_5m < ARB_THRESHOLD`

### Case C: Equal beat prices
- Check both sums and execute the first valid

## Features

- **Real-time WebSocket feeds** for market data
- **Atomic trade execution** with ≤50ms timeout
- **MongoDB persistence** for trade records and market data
- **JSON logging** for market pairs
- **Simulation/backtesting** engine
- **Latency-aware architecture** with stale-data protection
- **Risk controls** (daily trade limits, position sizing)

## Installation

```bash
npm install
npm run build
```

## Configuration

Create a `.env` file:

```env
# Arbitrage threshold (default: 0.9)
ARB_THRESHOLD=0.9

# Slippage buffer (default: 0.05)
SLIPPAGE_BUFFER=0.05

# Execution timeout in ms (default: 50)
EXECUTION_TIMEOUT_MS=50

# MongoDB connection
MONGO_URI=mongodb://localhost:27017
MONGO_DB_NAME=btc_arbitrage

# Trading
ENABLE_TRADING=0  # Set to 1 to enable actual trading
DEFAULT_QUANTITY=10

# Logging
LOG_DIR=./logs
ENABLE_JSON_LOGS=1
LOG_LEVEL=info

# Risk controls
MAX_DAILY_TRADES=100
MAX_POSITION_SIZE=1000

# Data freshness
MAX_DATA_AGE_MS=5000
CANCEL_BEFORE_END_TIME_MS=10000

# Polymarket Wallet Configuration (REQUIRED for trading)
POLY_PRIVATE_KEY=your_private_key_here  # EOA private key (with or without 0x prefix)
POLY_WALLET_TYPE=0  # 0=EOA (main wallet), 1=proxy, 2=proxy type 2
POLY_FUNDER=your_proxy_wallet_address  # Required if using proxy wallet (POLY_WALLET_TYPE=1 or 2)
POLY_RPC_URL=https://polygon-rpc.com  # Polygon RPC endpoint (can use Infura, Alchemy, etc.)

# Polymarket Exchange Contract Address (OPTIONAL - defaults to correct address)
# IMPORTANT: This is the Polymarket Exchange SMART CONTRACT address, NOT your wallet address
# It's the contract that needs approval to spend your USDC
# Default: 0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E (from py-clob-client)
# Only set this if you need to override the default
# POLYMARKET_EXCHANGE_ADDRESS=0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E
```

## Usage

### Run the bot

```bash
npm start
# or
npm run dev
```

### Run simulation

```bash
npm run simulate
```

## Architecture

```
src/
├── clients/
│   └── polymarket.ts          # Polymarket API client
├── services/
│   ├── arbitrage-orchestrator.ts  # Main orchestrator
│   ├── market-data-manager.ts     # WebSocket market data manager
│   ├── arbitrage-detector.ts      # Arbitrage detection engine
│   ├── trade-executor.ts          # Atomic trade execution
│   ├── database.ts                # MongoDB service
│   ├── json-logger.ts             # JSON log file system
│   └── simulation-engine.ts       # Backtesting engine
├── types.ts                       # Type definitions
├── config.ts                      # Configuration
├── utils/
│   ├── logger.ts                  # Logging utilities
│   └── retry.ts                   # Retry logic
├── index.ts                       # Main entry point
└── simulate.ts                    # Simulation entry point
```

## MongoDB Schemas

### Trade Record
```typescript
{
  timestamp: number;
  market5_id: string;
  market15_id: string;
  direction: { upMarket: "5m" | "15m", downMarket: "5m" | "15m" };
  price_up: number;
  price_down: number;
  sum_price: number;
  quantity: number;
  latency_ms: number;
  status: "filled" | "canceled" | "failed";
  pnl_estimate: number;
}
```

### Market Data Record
```typescript
{
  market_id: string;
  market_type: "5m" | "15m";
  start_time: number;
  end_time: number;
  beat_price: number;
  final_finish_price: number | null;
  result: "UP" | "DOWN" | "PENDING";
  price_timeline: PriceSnapshot[];
}
```

## Logging

### Terminal Logging

When synchronized markets are detected, the bot prints:
```
[SYNC DETECTED]
Direction: BUY UP in 5m / BUY DOWN in 15m
Prices: up=0.45, down=0.42
Sum: 0.87
Timestamp: 2024-01-01T12:00:00Z
```

### JSON Log Files

One JSON log per market pair containing:
- Beat prices
- Detected direction
- Trade attempts
- Execution results
- Final resolution outcome
- Realized PnL

## Risk Controls

- **Daily trade limit**: Maximum trades per day
- **Position sizing**: Maximum position size
- **Stale data protection**: Rejects trades on stale data
- **Latency monitoring**: Tracks execution latency
- **Auto-cancel**: Cancels orders near `endTime`

## Simulation/Backtesting

The simulation engine:
- Reads historical market JSON logs
- Replays beat prices, token prices, and `endTime` events
- Runs the same arbitrage logic
- Outputs:
  - Total trades
  - Win rate
  - PnL curve
  - Max drawdown
  - Latency sensitivity

## Wallet Approval

The bot implements proper EOA (Externally Owned Account) wallet approval:

1. **On-chain USDC approval**: Grants the Polymarket exchange contract permission to spend USDC
2. **API balance allowance**: Updates CLOB API with current allowances
3. **Conditional token approval**: Updates allowance for specific conditional tokens before each trade

The approval process runs automatically on bot startup if `ENABLE_TRADING=1`.

## Production Considerations

- ✅ EOA wallet approval implemented
- ✅ CLOB API integration for order placement
- ✅ Proper error handling and recovery
- Set up monitoring and alerting
- Configure proper MongoDB indexes
- Implement rate limiting for API calls
- Add circuit breakers for market volatility
- Verify contract addresses are up-to-date

## License

ISC
