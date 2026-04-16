# BTC 5-15 Minute Arbitrage Bot

Production-grade BTC binary prediction market arbitrage bot for Polymarket.

## Overview

This bot monitors BTC 5-minute and 15-minute binary prediction markets and executes arbitrage trades when synchronized markets (same `endTime`) are detected. The architecture is built around a **Zero Naked Exposure** guarantee: if only one leg of a two-leg trade fills, the filled position is immediately unwound before the bot can take any further action.

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

## Zero Naked Exposure Architecture

The Polymarket batch order endpoint is **not atomic** — the matching engine processes legs sequentially. This means one leg can fill while the other misses, leaving a naked directional position.

The bot handles this with a two-stage execution model:

1. **Place both legs** (UP and DOWN) as FOK orders
2. **Detect partial fill**: if only one leg is matched, trigger immediate unwind
3. **Unwind**: submit a FAK SELL at `$0.01` (sweeps all bids) for the filled leg
4. **If unwind fails**: throw `UnwindFailedError`, persist a `partial_unwind` record to MongoDB, and **halt the bot immediately** — no further trades are attempted

```
executeTradeBatch()
  ├─ place UP leg (FOK)
  ├─ place DOWN leg (FOK)
  ├─ both filled → success ✓
  ├─ neither filled → clean miss ✓
  └─ one filled, one missed
       ├─ unwindPosition() → FAK SELL at $0.01
       ├─ unwind success → log partial_unwind, continue ✓
       └─ unwind fails → UnwindFailedError → HALT BOT ✗
```

### Trade Statuses

| Status | Meaning |
|---|---|
| `filled` | Both legs matched; full arbitrage executed |
| `canceled` | Neither leg filled (clean miss) |
| `failed` | Unexpected API/network error |
| `partial_unwind` | One leg filled, unwind triggered — **requires manual review** |

## Execution Safety Features

### Volatility Filter

Before executing any trade, the bot checks whether the market is moving too fast to enter safely:
- Computes `max(price) - min(price)` over the recent 60-snapshot history window (~30 seconds)
- Aborts the trade if the range exceeds `MAX_PRICE_VOLATILITY` on either the UP or DOWN side
- The filter is dormant until `MIN_HISTORY_FOR_FILTER` snapshots have accumulated (prevents false positives on startup)

### Dynamic Slippage Estimation

Instead of a flat slippage allowance, each trade leg gets an individually estimated slippage:
- Computes average absolute tick-to-tick price change from history
- Expresses as a fraction of current price with a 1.5× safety buffer
- Clamped to `[MAX_SLIPPAGE, 2 × MAX_SLIPPAGE]`
- If slippage-adjusted sum ≥ `ARB_THRESHOLD`, the trade is skipped as no longer profitable

### Market Data Write Throttle

WebSocket ticks arrive at 100+ per second. The bot throttles MongoDB market-data writes to once per **5 seconds per market**, preventing async operation backpressure and heap memory exhaustion.

## Features

- **Real-time WebSocket feeds** for market data
- **Zero Naked Exposure** guarantee via emergency unwind
- **Volatility gate** — skips trades during fast-moving markets
- **Dynamic slippage estimation** — per-leg, history-based
- **Atomic trade execution** targeting ≤50ms latency
- **MongoDB persistence** for trade records and market data
- **JSON logging** for market pairs
- **Simulation/backtesting** engine
- **Latency-aware architecture** with stale-data protection
- **Risk controls** (daily trade limits, position sizing)
- **Window rollover detection** — auto-switches to current 5m/15m markets

## Installation

```bash
npm install
npm run build
```

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Key variables:

```env
# Arbitrage threshold — sum of both legs must be below this (default: 0.9)
ARB_THRESHOLD=0.9

# Slippage buffer — gap below threshold that triggers market vs limit orders (default: 0.05)
SLIPPAGE_BUFFER=0.05

# Flat maximum slippage per leg; also used as dynamic estimate floor (default: 0.02)
MAX_SLIPPAGE=0.02

# Execution timeout in ms (default: 50)
EXECUTION_TIMEOUT_MS=50

# MongoDB connection
MONGO_URI=mongodb://localhost:27017
MONGO_DB_NAME=btc_arbitrage

# Trading — set to 1 to enable live order placement
ENABLE_TRADING=0
DEFAULT_QUANTITY=10

# Risk controls
MAX_DAILY_TRADES=100
MAX_POSITION_SIZE=1000

# Volatility filter — abort if UP/DOWN price range over history exceeds this (default: 0.05)
MAX_PRICE_VOLATILITY=0.05

# Minimum history snapshots before volatility/slippage filters activate (default: 10)
MIN_HISTORY_FOR_FILTER=10

# Polymarket wallet (REQUIRED for trading)
POLY_PRIVATE_KEY=your_private_key_here
POLY_WALLET_TYPE=0       # 0=EOA, 1=proxy, 2=proxy type 2
POLY_RPC_URL=https://polygon-rpc.com

# Polygon RPC — use Alchemy/Infura for reliability
# POLY_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
```

See `.env.example` for the full list of variables with documentation.

## Usage

### Observation mode (no trading)

```bash
ENABLE_TRADING=0 npm start
# or
npm run dev
```

### Live trading

```bash
ENABLE_TRADING=1 npm start
```

### Simulation / backtesting

```bash
npm run simulate
```

### Leg-risk verification suite

Runs 24 assertions across 5 scenarios covering both-filled, neither-filled, up-only-filled, down-only-filled, and the `UnwindFailedError` halt path:

```bash
npx ts-node src/test-leg-risk.ts
```

All 24 assertions must pass before deploying to live trading.

## Architecture

```
src/
├── clients/
│   ├── polymarket.ts          # Polymarket REST API client
│   └── clob-client.ts         # CLOB order placement (buy + sell/unwind)
├── services/
│   ├── arbitrage-orchestrator.ts  # Main orchestrator
│   ├── market-data-manager.ts     # WebSocket + price history ring buffer
│   ├── arbitrage-detector.ts      # Arbitrage detection, volatility filter,
│   │                              #   dynamic slippage estimation
│   ├── trade-executor.ts          # Zero Naked Exposure execution engine
│   │                              #   (FOK entry + FAK unwind + halt logic)
│   ├── database.ts                # MongoDB service (throttled writes)
│   ├── json-logger.ts             # JSON log file system
│   └── simulation-engine.ts       # Backtesting engine
├── types.ts                       # Type definitions (incl. partial_unwind status)
├── config.ts                      # Configuration
├── utils/
│   ├── logger.ts                  # Logging utilities
│   └── retry.ts                   # Retry logic
├── index.ts                       # Main entry point
├── simulate.ts                    # Simulation entry point
└── test-leg-risk.ts               # 24-assertion leg-risk verification suite
```

## MongoDB Schemas

### Trade Record

```typescript
{
  timestamp: number;
  market5_id: string;
  market15_id: string;
  direction: { upMarket: "5m" | "15m"; downMarket: "5m" | "15m" };
  price_up: number;
  price_down: number;
  sum_price: number;
  quantity: number;
  latency_ms: number;
  status: "filled" | "canceled" | "failed" | "partial_unwind";
  up_order_id?: string;
  down_order_id?: string;
  unwind_order_id?: string;   // set on partial_unwind records
  pnl_estimate: number;
  error?: string;
}
```

> **Important:** Records with `status: "partial_unwind"` indicate the bot halted after a failed or successful unwind. Review these manually before restarting live trading.

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
  price_timeline: PriceSnapshot[];  // last 60 snapshots (~30 seconds)
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

A `[CRITICAL]` log line followed by bot shutdown indicates an `UnwindFailedError` — a naked position may exist. Check MongoDB for the `partial_unwind` record.

### JSON Log Files

One JSON log per market pair containing:
- Beat prices
- Detected direction
- Trade attempts and execution results
- Slippage estimates used
- Final resolution outcome
- Realized PnL

## Risk Controls

| Control | Config Variable | Default |
|---|---|---|
| Daily trade limit | `MAX_DAILY_TRADES` | 100 |
| Max position size | `MAX_POSITION_SIZE` | 1000 USDC |
| Stale data rejection | `MAX_DATA_AGE_MS` | 5000 ms |
| Pre-expiry cancel window | `CANCEL_BEFORE_END_TIME_MS` | 10000 ms |
| Volatility gate | `MAX_PRICE_VOLATILITY` | 0.05 |
| Min history for filters | `MIN_HISTORY_FOR_FILTER` | 10 snapshots |
| Slippage floor | `MAX_SLIPPAGE` | 0.02 (2%) |

## Wallet Setup

The bot implements proper EOA wallet approval on startup:

1. **On-chain USDC approval**: Grants the Polymarket exchange contract permission to spend USDC
2. **API balance allowance**: Updates CLOB API with current allowances
3. **Conditional token approval**: Updates allowance for specific conditional tokens before each trade

The approval process runs automatically on bot startup if `ENABLE_TRADING=1`.

Supported wallet types (`POLY_WALLET_TYPE`):
- `0` — EOA (standard private-key wallet, most common)
- `1` — Proxy wallet (type 1)
- `2` — Proxy wallet (type 2)

## Production Checklist

- [ ] Run `npx ts-node src/test-leg-risk.ts` — all 24 assertions must pass
- [ ] Start in observation mode (`ENABLE_TRADING=0`) and verify beat prices load correctly
- [ ] Confirm MongoDB is running and `btc_arbitrage` database is accessible
- [ ] Set `POLY_RPC_URL` to a reliable Alchemy/Infura endpoint (not public RPC)
- [ ] Review `MAX_PRICE_VOLATILITY` and `MAX_SLIPPAGE` for current market conditions
- [ ] Set `ENABLE_TRADING=1` and `DEFAULT_QUANTITY` to your desired position size
- [ ] Monitor logs for any `partial_unwind` records after first live session

## License

ISC
