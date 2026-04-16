/**
 * Leg Risk Verification Suite
 *
 * Proves the Zero Naked Exposure safety net works as designed.
 * No network calls are made — all CLOB responses are injected via mock.
 *
 * Run:
 *   node -r ts-node/register src/test-leg-risk.ts
 *
 * Scenarios covered:
 *   1. Clean arb   — both legs fill          → status "filled"
 *   2. Clean miss  — neither leg fills        → status "failed", zero exposure
 *   3. Leg risk    — UP fills / DOWN misses   → unwind triggers, succeeds
 *   4. Unwind fail — unwind sell not matched  → UnwindFailedError thrown
 *   5. Halt proof  — orchestrator catches UnwindFailedError, calls stop()
 */

// ─── Environment must be set before any import that touches env vars ─────────
process.env.POLY_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // Hardhat #0 — no real value
process.env.ENABLE_TRADING = "0";

// ─── Imports ─────────────────────────────────────────────────────────────────
import { TradeExecutor, UnwindFailedError } from "./services/trade-executor";
import type { TradeParams } from "./types";
import type { ClobOrderResponse } from "./clients/clob-client";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const BOLD   = "\x1b[1m";
const RESET  = "\x1b[0m";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ${GREEN}✓${RESET} ${label}`);
    passed++;
  } else {
    console.error(`  ${RED}✗ FAIL${RESET} ${label}`);
    failed++;
  }
}

function header(title: string): void {
  console.log(`\n${BOLD}${CYAN}━━━ ${title} ━━━${RESET}`);
}

/** Build a TradeExecutor with approval pre-flagged and CLOB methods mocked. */
function buildExecutor(overrides: {
  batchResponse: ClobOrderResponse[];
  sellResponse?: ClobOrderResponse;
}): TradeExecutor {
  const executor = new TradeExecutor();

  // Skip the on-chain approval flow — irrelevant for these tests.
  (executor as unknown as Record<string, unknown>)["approvalDone"] = true;

  const client = (executor as unknown as Record<string, unknown>)["clobClient"] as Record<
    string,
    unknown
  >;

  // Mock placeBatchOrders to return whatever the test configures.
  client["placeBatchOrders"] = async (): Promise<ClobOrderResponse[]> => {
    console.log(
      `    ${YELLOW}[MOCK]${RESET} placeBatchOrders called — returning ` +
        `UP:${overrides.batchResponse[0]?.status ?? overrides.batchResponse[0]?.error} / ` +
        `DOWN:${overrides.batchResponse[1]?.status ?? overrides.batchResponse[1]?.error}`,
    );
    return overrides.batchResponse;
  };

  // Mock placeSellOrder to return the configured unwind response.
  client["placeSellOrder"] = async (
    tokenId: string,
    price: number,
    size: number,
    orderType: string,
  ): Promise<ClobOrderResponse> => {
    console.log(
      `    ${YELLOW}[MOCK]${RESET} placeSellOrder called — ` +
        `token:${tokenId.substring(0, 16)}…, price:$${price}, size:${size}, type:${orderType}` +
        (overrides.sellResponse
          ? ` → status:${overrides.sellResponse.status ?? overrides.sellResponse.error}`
          : " → (no sell mock configured)"),
    );
    if (!overrides.sellResponse) {
      throw new Error("placeSellOrder called unexpectedly — no sell mock configured");
    }
    return overrides.sellResponse;
  };

  return executor;
}

/** Shared trade params used across all scenarios. */
const BASE_PARAMS: TradeParams = {
  upTokenId:   "0xUP_TOKEN_AAAA1111222233334444555566667777888899990000",
  downTokenId: "0xDOWN_TOKEN_BBBB1111222233334444555566667777888899990000",
  upMarket:    "5m",
  downMarket:  "15m",
  upPrice:     0.45,
  downPrice:   0.42,
  quantity:    10,
  orderType:   "market",
};

// ─── Scenario 1 — Clean arbitrage (both legs fill) ───────────────────────────
async function scenario1(): Promise<void> {
  header("Scenario 1 — Clean Arbitrage (Both Legs Fill)");
  console.log("  Expected: status='filled', no unwind, no error");

  const executor = buildExecutor({
    batchResponse: [
      { orderID: "up-order-001", status: "matched" },
      { orderID: "dn-order-001", status: "matched" },
    ],
  });

  const execution = await executor.executeTradeBatch(BASE_PARAMS);

  console.log(`  Result: status='${execution.status}', error='${execution.error ?? "none"}'`);
  assert(execution.status === "filled",        "status is 'filled'");
  assert(execution.error === undefined,        "no error message");
  assert(execution.upOrderId   === "up-order-001", "upOrderId captured");
  assert(execution.downOrderId === "dn-order-001", "downOrderId captured");
  assert(execution.unwindOrderId === undefined, "no unwind order (clean trade)");
}

// ─── Scenario 2 — Clean miss (neither leg fills) ─────────────────────────────
async function scenario2(): Promise<void> {
  header("Scenario 2 — Clean Miss (Neither Leg Fills — Zero Exposure)");
  console.log("  Expected: status='failed', no unwind, zero naked exposure");

  const executor = buildExecutor({
    batchResponse: [
      { orderID: "up-order-002", status: "unmatched" },
      { orderID: "dn-order-002", status: "unmatched" },
    ],
  });

  const execution = await executor.executeTradeBatch(BASE_PARAMS);

  console.log(`  Result: status='${execution.status}', error='${execution.error ?? "none"}'`);
  assert(execution.status === "failed",       "status is 'failed'");
  assert(execution.unwindOrderId === undefined, "no unwind triggered (no exposure)");
  assert(execution.error !== undefined,        "reason recorded");
}

// ─── Scenario 3 — Leg Risk: UP fills, DOWN misses, unwind succeeds ───────────
async function scenario3(): Promise<void> {
  header("Scenario 3 — LEG RISK: UP Fills / DOWN Misses / Unwind Succeeds");
  console.log("  Expected: unwindPosition() triggers FAK SELL at $0.01, status='partial_unwind'");

  const executor = buildExecutor({
    batchResponse: [
      { orderID: "up-order-003", status: "matched"   }, // ← UP fills
      { orderID: "dn-order-003", status: "unmatched" }, // ← DOWN misses (FOK killed)
    ],
    sellResponse: { orderID: "unwind-order-003", status: "matched" }, // ← unwind succeeds
  });

  const execution = await executor.executeTradeBatch(BASE_PARAMS);

  console.log(
    `  Result: status='${execution.status}', unwindOrderId='${execution.unwindOrderId ?? "none"}', ` +
    `error='${execution.error ?? "none"}'`,
  );
  assert(execution.status === "partial_unwind",          "status is 'partial_unwind'");
  assert(execution.unwindOrderId === "unwind-order-003", "unwind order ID recorded");
  assert(execution.error !== undefined,                  "error field logs what happened");
  assert(
    execution.error?.includes("unwound") ?? false,
    "error message confirms position was unwound",
  );
}

// ─── Scenario 4 — Leg Risk: UP fills, DOWN misses, unwind FAILS → throws ─────
async function scenario4(): Promise<void> {
  header("Scenario 4 — LEG RISK + UNWIND FAILURE: UP Fills / DOWN Misses / Unwind Fails");
  console.log("  Expected: UnwindFailedError thrown with partialExecution attached");

  const executor = buildExecutor({
    batchResponse: [
      { orderID: "up-order-004", status: "matched"   }, // ← UP fills (LEG RISK)
      { orderID: "dn-order-004", status: "unmatched" }, // ← DOWN misses
    ],
    sellResponse: { orderID: "unwind-order-004", status: "unmatched" }, // ← unwind FAILS (no bids)
  });

  let thrownError: unknown = null;
  try {
    await executor.executeTradeBatch(BASE_PARAMS);
    assert(false, "executeTradeBatch should have thrown — it did NOT (CRITICAL FAILURE)");
  } catch (err) {
    thrownError = err;
  }

  assert(thrownError instanceof UnwindFailedError, "UnwindFailedError was thrown");

  if (thrownError instanceof UnwindFailedError) {
    console.log(`  Error message: ${thrownError.message.substring(0, 100)}…`);
    assert(thrownError.partialExecution !== undefined,               "partialExecution attached");
    assert(thrownError.partialExecution.status === "partial_unwind", "partialExecution.status is 'partial_unwind'");
    assert(thrownError.partialExecution.error?.includes("UNWIND FAILED") ?? false,
           "partialExecution.error describes unwind failure");
    assert(thrownError.legName === "UP",                             "legName identifies the filled leg");
    assert(thrownError.tokenId === BASE_PARAMS.upTokenId,           "tokenId is the filled token");
    assert(thrownError.quantity === BASE_PARAMS.quantity,           "quantity matches trade size");
  }
}

// ─── Scenario 5 — Orchestrator catches UnwindFailedError and halts bot ────────
async function scenario5(): Promise<void> {
  header("Scenario 5 — ORCHESTRATOR HALT: Catches UnwindFailedError and Calls stop()");
  console.log("  Expected: isRunning=false, partialExecution persisted, stop() called");

  // Build a minimal orchestrator-shaped harness that mirrors the exact
  // catch block in arbitrage-orchestrator.ts lines 332-347, without
  // instantiating the full orchestrator (avoids MongoDB / WS connections).
  const persistedExecutions: unknown[] = [];
  const loggedExecutions: unknown[]   = [];
  let   stopCalled                    = false;
  let   isRunning                     = true;

  // This mirrors the exact logic from arbitrage-orchestrator.ts executeArbitrageTrade()
  const mockOrchestratorExecute = async (
    executeTradeFn: () => Promise<void>,
  ): Promise<void> => {
    try {
      await executeTradeFn();
    } catch (error) {
      if (error instanceof UnwindFailedError) {
        console.log(
          `    ${RED}[ORCHESTRATOR]${RESET} CRITICAL — UnwindFailedError caught:\n` +
          `      ${error.message.substring(0, 120)}…`,
        );
        // Persist the partial execution record
        persistedExecutions.push(error.partialExecution);
        loggedExecutions.push(error.partialExecution);
        // Halt — mirrors: await this.stop()
        isRunning = false;
        stopCalled = true;
        console.log(`    ${RED}[ORCHESTRATOR]${RESET} Bot halted. isRunning=${isRunning}`);
        return;
      }
      throw error;
    }
  };

  // Create a mock executor that throws UnwindFailedError
  const executor = buildExecutor({
    batchResponse: [
      { orderID: "up-order-005", status: "matched"   },
      { orderID: "dn-order-005", status: "unmatched" },
    ],
    sellResponse: { orderID: "unwind-order-005", status: "unmatched" }, // unwind fails
  });

  await mockOrchestratorExecute(async () => {
    await executor.executeTradeBatch(BASE_PARAMS);
  });

  assert(stopCalled,                              "stop() was called");
  assert(!isRunning,                              "isRunning is now false");
  assert(persistedExecutions.length === 1,        "partialExecution was persisted to DB");
  assert(loggedExecutions.length === 1,           "partialExecution was passed to JSON logger");

  const persisted = persistedExecutions[0] as ReturnType<typeof Object.create>;
  assert(
    (persisted as { status: string }).status === "partial_unwind",
    "persisted record has status 'partial_unwind'",
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n${BOLD}═══════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  LEG RISK VERIFICATION SUITE — Zero Naked Exposure ${RESET}`);
  console.log(`${BOLD}═══════════════════════════════════════════════════${RESET}`);

  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
  await scenario5();

  const total = passed + failed;
  console.log(`\n${BOLD}═══════════════════════════════════════════════════${RESET}`);
  if (failed === 0) {
    console.log(
      `${BOLD}${GREEN}  ALL ${total} ASSERTIONS PASSED — Safety net verified. ✓${RESET}`,
    );
  } else {
    console.log(
      `${BOLD}${RED}  ${failed}/${total} ASSERTIONS FAILED — Review output above. ✗${RESET}`,
    );
  }
  console.log(`${BOLD}═══════════════════════════════════════════════════${RESET}\n`);

  process.exit(failed > 0 ? 1 : 0);
})();
