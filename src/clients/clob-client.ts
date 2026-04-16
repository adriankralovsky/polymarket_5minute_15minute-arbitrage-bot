/**
 * Polymarket CLOB API client for order placement
 * Implements EOA wallet approval and order execution
 */

import { createHmac } from "crypto";
import { ethers } from "ethers";
import { logInfo, logError, logWarn, logDebug } from "../utils/logger";
import { retry } from "../utils/retry";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon

/**
 * Build an ethers provider from POLY_RPC_URL.
 * Supports a comma-separated list of URLs for automatic fallback:
 *   POLY_RPC_URL=https://primary-rpc.com,https://fallback-rpc.com
 * With multiple URLs, FallbackProvider is used (tries each in order of priority).
 */
function buildPolygonProvider(): ethers.JsonRpcProvider | ethers.FallbackProvider {
  const raw = process.env.POLY_RPC_URL || "https://polygon-rpc.com";
  const urls = raw.split(",").map((u) => u.trim()).filter(Boolean);
  if (urls.length === 1) {
    return new ethers.JsonRpcProvider(urls[0]);
  }
  const providers = urls.map((url, i) =>
    ({ provider: new ethers.JsonRpcProvider(url), priority: urls.length - i, stallTimeout: 2000 })
  );
  return new ethers.FallbackProvider(providers, CHAIN_ID);
}

// ERC20 approve ABI
const ERC20_APPROVE_ABI = [
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
];

// Contract addresses for Polygon
// IMPORTANT: POLYMARKET_EXCHANGE_ADDRESS is the Polymarket Exchange SMART CONTRACT address
// It is NOT your wallet address (neither proxy nor MetaMask wallet)
// This is the contract that needs approval to spend your USDC
// 
// Correct address from py-clob-client get_contract_config(137): 0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E
function getChecksummedAddress(address: string, addressName: string): string | null {
  try {
    return ethers.getAddress(address);
  } catch {
    // Log warning will be done in the class where logger is available
    console.warn(`[WARN] Invalid ${addressName} address checksum: ${address}. On-chain approval will be skipped.`);
    return null;
  }
}

// Exchange contract address (from py-clob-client get_contract_config for chain_id=137)
// This is the Polymarket exchange smart contract, NOT a wallet address
const DEFAULT_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const exchangeAddress = process.env.POLYMARKET_EXCHANGE_ADDRESS || DEFAULT_EXCHANGE_ADDRESS;
const POLYMARKET_CONTRACTS = {
  exchange: getChecksummedAddress(exchangeAddress, "exchange"), // Polymarket Exchange contract
  collateral: getChecksummedAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", "collateral")!, // USDC on Polygon
};

export interface OrderArgs {
  price: number;
  size: number;
  side: "BUY" | "SELL";
  tokenId: string;
  expiration?: number; // For GTD orders (Unix timestamp in seconds, 0 for GTC)
}

// Full order object structure per Polymarket API
export interface PolymarketOrder {
  salt: number; // Random salt for unique order
  maker: string; // Maker address (funder)
  signer: string; // Signing address
  taker: string; // Taker address (operator, usually zero address)
  tokenId: string; // ERC1155 token ID
  makerAmount: string; // Maximum amount maker is willing to spend (in wei)
  takerAmount: string; // Minimum amount taker will pay (in wei)
  expiration: string; // Unix expiration timestamp (0 for GTC)
  nonce: string; // Maker's exchange nonce
  feeRateBps: string; // Fee rate basis points
  side: "BUY" | "SELL";
  signatureType: number; // 0=EOA, 1/2=proxy
  signature: string; // Hex encoded signature
}

// PostOrder structure per Polymarket API
export interface PostOrderPayload {
  order: PolymarketOrder;
  owner?: string; // API key (optional, may be required for some endpoints)
  orderType: "FOK" | "FAK" | "GTC" | "GTD";
  postOnly?: boolean; // If true, order only rests on book (default: false)
}

export interface ClobOrderResponse {
  orderID?: string;
  status?: string;
  error?: string;
  raw?: unknown;
}

export class ClobClient {
  private privateKey: string;
  private wallet: ethers.Wallet;
  private provider: ethers.JsonRpcProvider | ethers.FallbackProvider;
  private signatureType: number;
  private funder: string | null = null;
  // L2 API-key credentials — required for account-scoped REST calls
  // (getOpenOrders, cancelOrder). These are SEPARATE from the trading wallet.
  private apiKey: string | null = null;
  private apiSecret: string | null = null;
  private apiPassphrase: string | null = null;
  private nonce: number | null = null; // Exchange nonce (fetched from API)

  constructor() {
    const key = process.env.POLY_PRIVATE_KEY?.trim();
    if (!key) {
      throw new Error("POLY_PRIVATE_KEY not set in environment");
    }

    this.privateKey = key.startsWith("0x") ? key : `0x${key}`;
    this.provider = buildPolygonProvider();
    this.wallet = new ethers.Wallet(this.privateKey, this.provider);

    // Wallet type configuration
    const walletType = (
      process.env.POLY_WALLET_TYPE || process.env.POLY_SIGNATURE_TYPE || "0"
    ).trim().toLowerCase();

    if (walletType === "main" || walletType === "eoa" || walletType === "0") {
      this.signatureType = 0;
      this.funder = null;
    } else if (walletType === "proxy" || walletType === "1" || walletType === "2") {
      this.signatureType = walletType === "2" ? 2 : 1;
      this.funder = process.env.POLY_FUNDER?.trim() || null;
      if (!this.funder) {
        logWarn("POLY_FUNDER required for proxy wallet");
      }
    } else {
      // parseInt never throws — it returns NaN for non-numeric input.
      // NaN embedded in the EIP-712 signatureType field produces a malformed
      // order that the exchange always rejects. Fall back to 0 (EOA) instead.
      const parsed = parseInt(walletType, 10);
      if (Number.isNaN(parsed)) {
        logWarn(`Unrecognised POLY_WALLET_TYPE "${walletType}" — defaulting to EOA (0)`);
        this.signatureType = 0;
        this.funder = null;
      } else {
        this.signatureType = parsed;
        this.funder = process.env.POLY_FUNDER?.trim() || null;
      }
    }

    // L2 API credentials (for order cancellation and account reads)
    this.apiKey        = process.env.POLY_API_KEY?.trim()        ?? null;
    this.apiSecret     = process.env.POLY_API_SECRET?.trim()     ?? null;
    this.apiPassphrase = process.env.POLY_API_PASSPHRASE?.trim() ?? null;

    if (!this.apiKey || !this.apiSecret || !this.apiPassphrase) {
      logWarn(
        "POLY_API_KEY / POLY_API_SECRET / POLY_API_PASSPHRASE not set. " +
        "Pre-expiry order cancellation will be disabled. " +
        "Set these credentials to enable safe order management.",
      );
    }

    logInfo("CLOB Client initialized", {
      address: this.wallet.address,
      signatureType: this.signatureType,
      funder: this.funder || "none",
      l2Auth: this.apiKey ? "configured" : "missing",
    });
  }

  /**
   * Build Polymarket L2 API authentication headers.
   *
   * Account-scoped REST endpoints (order reads, order cancels) require HMAC-SHA256
   * authentication using the CLOB API key — NOT the trading wallet signature.
   *
   * Signature: base64( HMAC-SHA256( apiSecret, timestamp + METHOD + path + body ) )
   * Per py-clob-client: https://github.com/Polymarket/py-clob-client
   */
  private buildL2AuthHeaders(
    method: string,
    requestPath: string,
    body: string = "",
  ): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message   = timestamp + method.toUpperCase() + requestPath + body;
    // The API secret is stored base64-encoded; decode to raw bytes before use
    // as the HMAC key — passing the base64 string directly produces a different
    // hash and every authenticated request returns 401.
    const secret    = Buffer.from(this.apiSecret!, "base64");
    const signature = createHmac("sha256", secret)
      .update(message)
      .digest("base64");
    return {
      "POLY-TIMESTAMP":  timestamp,
      "POLY-SIGNATURE":  signature,
      "POLY-API-KEY":    this.apiKey!,
      "POLY-PASSPHRASE": this.apiPassphrase!,
    };
  }

  /**
   * Get wallet address
   */
  getAddress(): string {
    return this.wallet.address;
  }

  /**
   * Fetch exchange nonce from API
   * According to Polymarket CLOB API, nonce must be fetched before placing orders
   */
  async fetchNonce(): Promise<number> {
    if (this.nonce !== null) {
      return this.nonce;
    }

    try {
      const url = `${CLOB_HOST}/nonce?address=${this.wallet.address}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to fetch exchange nonce: HTTP ${response.status}`);
      }

      const data = (await response.json()) as { nonce?: number; nonce_value?: number };
      this.nonce = data.nonce ?? data.nonce_value ?? 0;
      logDebug(`Fetched exchange nonce: ${this.nonce}`);
      return this.nonce;
    } catch (error) {
      throw new Error(`Failed to fetch exchange nonce: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Increment nonce after order placement
   */
  private incrementNonce(): void {
    if (this.nonce !== null) {
      this.nonce++;
    }
  }

  /**
   * Calculate market price for a specific token, side, and amount.
   *
   * The `/calculate_market_price` endpoint interprets `amount` differently by side:
   *   BUY  → amount is the USDC to spend (cost), NOT the number of shares desired.
   *   SELL → amount is the number of shares to sell.
   *
   * Callers must convert share quantities to USDC cost before calling for BUY:
   *   usdcAmount = shares * estimatedPrice
   *
   * @param tokenID   - Token ID
   * @param side      - "BUY" or "SELL"
   * @param amount    - USDC cost (BUY) or share count (SELL)
   * @param orderType - Order type (default: "FOK")
   * @returns Per-share price at the given depth, or null on failure
   */
  async calculateMarketPrice(
    tokenID: string,
    side: "BUY" | "SELL",
    amount: number,
    orderType: "GTC" | "FOK" | "GTD" | "FAK" = "FOK"
  ): Promise<number | null> {
    try {
      const url = `${CLOB_HOST}/calculate_market_price`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token_id: tokenID,
          side: side,
          amount: amount.toString(),
          order_type: orderType,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logWarn(`calculateMarketPrice failed for ${tokenID}: ${response.status} ${errorText}`);
        return null;
      }

      const data = (await response.json()) as { price?: string; [key: string]: unknown };
      if (data.price) {
        const price = parseFloat(data.price as string);
        logDebug(`Calculated market price for ${tokenID} (${side}, ${amount}): ${price}`);
        return price;
      }

      return null;
    } catch (error) {
      logError(`Failed to calculate market price for ${tokenID}:`, error);
      return null;
    }
  }

  /**
   * Get executable buy price for a specific token and amount
   * Uses calculateMarketPrice for accurate price considering orderbook depth
   * Falls back to getPrice if calculation fails
   */
  async getExecutableBuyPrice(tokenID: string, amount: number): Promise<number | null> {
    // calculateMarketPrice expects USDC cost for BUY, not share count.
    // Use a rough estimate: amount * 0.5 (midpoint) as the USDC proxy.
    // This is only used for pre-trade price discovery, not order construction.
    const usdcEstimate = amount * 0.5;
    const calculatedPrice = await this.calculateMarketPrice(tokenID, "BUY", usdcEstimate, "FOK");
    if (calculatedPrice !== null && calculatedPrice > 0) {
      return calculatedPrice;
    }

    // Fallback to simple price endpoint (side must be lowercase per API spec)
    try {
      const url = `${CLOB_HOST}/price?token_id=${tokenID}&side=buy`;
      const response = await fetch(url);
      if (response.ok) {
        const data = (await response.json()) as { price?: string };
        if (data.price) {
          return parseFloat(data.price);
        }
      }
    } catch (error) {
      logDebug(`getPrice fallback failed for ${tokenID}:`, error);
    }

    return null;
  }

  /**
   * Check current USDC allowance
   */
  async getUsdcAllowance(): Promise<bigint> {
    if (!POLYMARKET_CONTRACTS.exchange) {
      logWarn("Exchange address not valid, skipping allowance check");
      return BigInt(0);
    }
    try {
      const usdcContract = new ethers.Contract(
        POLYMARKET_CONTRACTS.collateral,
        ERC20_APPROVE_ABI,
        this.provider,
      );
      const allowance = await usdcContract.allowance(
        this.wallet.address,
        POLYMARKET_CONTRACTS.exchange,
      );
      return allowance;
    } catch (error) {
      logError("Failed to get USDC allowance:", error);
      return BigInt(0);
    }
  }

  /**
   * Approve USDC on-chain (requirement: must be called before trading)
   */
  async approveUsdcOnChain(): Promise<boolean> {
    if (!POLYMARKET_CONTRACTS.exchange) {
      logWarn("Exchange address not valid (bad checksum). Skipping on-chain approval.");
      logWarn("Please set POLYMARKET_EXCHANGE_ADDRESS in .env with the correct checksummed address.");
      logWarn("Trading may still work if approval was done manually or via API.");
      return false; // Return false but don't block - API approval might work
    }
    
    try {
      const currentAllowance = await this.getUsdcAllowance();
      const maxUint256 = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

      // Check if already approved
      if (currentAllowance >= maxUint256 / BigInt(2)) {
        logInfo("USDC already approved, skipping on-chain approval");
        return true;
      }

      logInfo("Approving USDC on-chain...");
      const usdcContract = new ethers.Contract(
        POLYMARKET_CONTRACTS.collateral,
        ERC20_APPROVE_ABI,
        this.wallet,
      );

      const tx = await usdcContract.approve(POLYMARKET_CONTRACTS.exchange, maxUint256, {
        gasLimit: 100000,
      });

      logInfo(`USDC approval transaction sent: ${tx.hash}`);
      const receipt = await tx.wait();
      logInfo(`USDC approval confirmed in block ${receipt.blockNumber}`);
      return true;
    } catch (error) {
      if (error instanceof Error && (error.message.toLowerCase().includes("allowance") || error.message.toLowerCase().includes("revert"))) {
        logInfo("USDC approval may already be set, continuing...");
        return true;
      }
      logError("Failed to approve USDC on-chain:", error);
      return false;
    }
  }

  /**
   * Update balance allowance via API (for CLOB)
   * Note: This endpoint may not be available or may require different authentication
   * Making it non-blocking - on-chain approval is the critical step
   */
  async updateBalanceAllowance(assetType: "COLLATERAL" | "CONDITIONAL", tokenId?: string): Promise<boolean> {
    try {
      // Try the API endpoint, but don't fail if it's not available
      // The on-chain approval is the critical part
      const url = `${CLOB_HOST}/balance_allowance`;
      const body: {
        asset_type: string;
        signature_type?: number;
        token_id?: string;
      } = {
        asset_type: assetType,
        signature_type: -1, // Use -1 to update from on-chain
      };

      if (tokenId) {
        body.token_id = tokenId;
      }

      // Create signature for the request
      const message = JSON.stringify(body);
      const signature = await this.wallet.signMessage(ethers.toUtf8Bytes(message));

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Address": this.wallet.address,
          "X-Signature": signature,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        // API endpoint might not exist or require different auth - this is OK
        // On-chain approval is what matters
        logDebug(`Balance allowance API update not available (${response.status}), continuing with on-chain approval only`);
        return true; // Return true to not block the process
      }

      logInfo(`Balance allowance updated for ${assetType}${tokenId ? ` (token: ${tokenId.substring(0, 20)}...)` : ""}`);
      return true;
    } catch (error) {
      // Non-critical - on-chain approval is what matters
      logDebug(`Balance allowance API update failed (non-critical): ${error instanceof Error ? error.message : String(error)}`);
      return true; // Return true to not block the process
    }
  }

  /**
   * Run full approval process (on-chain + API)
   * Must be called before trading
   */
  async approve(): Promise<boolean> {
    logInfo("Running approval process...");

    // 1. On-chain USDC approve
    const onChainSuccess = await this.approveUsdcOnChain();
    if (!onChainSuccess) {
      logWarn("On-chain approval failed, but continuing...");
    }

    // 2. API update for collateral (USDC)
    await this.updateBalanceAllowance("COLLATERAL");

    // 3. API update for conditional tokens (general)
    await this.updateBalanceAllowance("CONDITIONAL");

    logInfo("Approval process completed");
    return onChainSuccess;
  }

  /**
   * L1 Method: Create and sign a limit order locally (without posting)
   * According to https://docs.polymarket.com/developers/CLOB/clients/methods-l1#createorder
   * This follows the L1 methods pattern: sign locally, then post via L2 methods
   * Returns the full signed order object ready for posting
   */
  async createOrder(args: OrderArgs): Promise<PolymarketOrder> {
    // Fetch nonce if not already fetched
    if (this.nonce === null) {
      await this.fetchNonce();
    }

    // Generate random salt for unique order
    const salt = Math.floor(Math.random() * 2147483647); // Random 32-bit integer

    // Determine maker and signer addresses
    const maker = this.funder || this.wallet.address; // Maker is funder (proxy) or wallet (EOA)
    const signer = this.wallet.address; // Signer is always the wallet
    const taker = "0x0000000000000000000000000000000000000000"; // Zero address for open orders

    // Safe BigInt wei conversion — avoids IEEE-754 precision loss at size >= 9.
    // Callers have already rounded price to 4dp and size to 2dp, so:
    //   priceMicro  = price * 1e4  (exact integer)
    //   sizeHundreds = size * 1e2  (exact integer)
    //
    // BUY:  makerAmount (USDC, 6dp) = price * size * 1e6
    //         = (priceMicro/1e4) * (sizeHundreds/1e2) * 1e6
    //         = priceMicro * sizeHundreds              (units cancel)
    //       takerAmount (shares, 18dp) = size * 1e18
    //         = (sizeHundreds/1e2) * 1e18
    //         = sizeHundreds * 1e16
    // SELL: directions reversed.
    const priceMicro   = BigInt(Math.round(args.price * 1e4));
    const sizeHundreds = BigInt(Math.round(args.size  * 1e2));

    // Polymarket CTFExchange conditional (outcome) tokens use 6 decimal places,
    // matching USDC — NOT 18dp like most ERC-20s. 1 outcome share = 1e6 base units.
    // Source: py-clob-client CONDITIONAL_TOKEN_DECIMALS = 6.
    //
    // sharesAmount  = size * 1e6
    //              = (sizeHundreds / 1e2) * 1e6
    //              = sizeHundreds * 1e4          ← multiplier is 1e4, not 1e16
    const SHARE_MULTIPLIER = BigInt("10000"); // 1e4 → 6dp shares

    let makerAmount: bigint;
    let takerAmount: bigint;

    if (args.side === "BUY") {
      makerAmount = priceMicro * sizeHundreds;          // USDC (6dp)
      takerAmount = sizeHundreds * SHARE_MULTIPLIER;    // shares (6dp)
    } else {
      makerAmount = sizeHundreds * SHARE_MULTIPLIER;    // shares (6dp)
      takerAmount = priceMicro * sizeHundreds;          // USDC (6dp)
    }

    const expiration = args.expiration || 0;
    const nonce = (this.nonce ?? 0) as number;
    const side = args.side === "BUY" ? 0 : 1; // 0=BUY, 1=SELL per contract

    // EIP-712 typed-data signing — matches the Polymarket CTFExchange contract.
    // The contract verifies ecrecover against a domain-separated EIP-712 hash.
    // EIP-191 personal_sign (signMessage) produces a different hash and will be
    // rejected by the exchange with a signature validation error.
    const domain = {
      name: "CTFExchange",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: (POLYMARKET_CONTRACTS.exchange ?? DEFAULT_EXCHANGE_ADDRESS) as string,
    };

    const types = {
      Order: [
        { name: "salt",          type: "uint256" },
        { name: "maker",         type: "address" },
        { name: "signer",        type: "address" },
        { name: "taker",         type: "address" },
        { name: "tokenId",       type: "uint256" },
        { name: "makerAmount",   type: "uint256" },
        { name: "takerAmount",   type: "uint256" },
        { name: "expiration",    type: "uint256" },
        { name: "nonce",         type: "uint256" },
        { name: "feeRateBps",    type: "uint256" },
        { name: "side",          type: "uint8"   },
        { name: "signatureType", type: "uint8"   },
      ],
    };

    const orderValue = {
      salt:          BigInt(salt),
      maker,
      signer,
      taker,
      tokenId:       BigInt(args.tokenId),
      makerAmount,
      takerAmount,
      expiration:    BigInt(expiration),
      nonce:         BigInt(nonce),
      feeRateBps:    BigInt(0),
      side,
      signatureType: this.signatureType,
    };

    const signature = await this.wallet.signTypedData(domain, types, orderValue);

    return {
      salt,
      maker,
      signer,
      taker,
      tokenId: args.tokenId,
      makerAmount: makerAmount.toString(),
      takerAmount: takerAmount.toString(),
      expiration: expiration.toString(),
      nonce: nonce.toString(),
      feeRateBps: "0",
      side: args.side,
      signatureType: this.signatureType,
      signature,
    };
  }

  /**
   * Place a buy order
   * According to https://docs.polymarket.com/developers/CLOB/orders/create-order
   * Uses POST /order endpoint with proper order structure
   */
  async placeBuyOrder(
    tokenId: string,
    price: number,
    size: number,
    orderType: "FOK" | "FAK" | "GTC" | "GTD" = "FOK",
    expiration?: number,
  ): Promise<ClobOrderResponse> {
    try {
      // Update conditional token allowance for this specific token
      await this.updateBalanceAllowance("CONDITIONAL", tokenId);

      // Round price and size according to API requirements
      // Price: max 4 decimals, Size: max 2 decimals
      const roundedPrice = Math.round(price * 10000) / 10000;
      let roundedSize = Math.round(size * 100) / 100;

      // Ensure minimum order value of $1
      if (roundedPrice * roundedSize < 1.0) {
        roundedSize = Math.ceil((1.0 / roundedPrice) * 100) / 100;
      }

      // NOTE: The former `while (decimalPlaces(price * size) > 2)` loop has been
      // removed. IEEE-754 means almost every float product has 20 "decimal places"
      // as reported by toFixed(20), so the loop incremented size without bound.
      // createOrder uses BigInt(Math.round(price * 1e4)) * BigInt(Math.round(size * 1e2))
      // internally, which always produces an exact integer — the loop was unnecessary.

      // Create full order object
      const orderArgs: OrderArgs = {
        price: roundedPrice,
        size: roundedSize,
        side: "BUY",
        tokenId,
        expiration: expiration || (orderType === "GTD" ? Math.floor(Date.now() / 1000) + 3600 : 0),
      };

      // Use L1 method to create and sign order locally
      const order = await this.createOrder(orderArgs);

      // Build PostOrder payload per API spec
      const postOrder: PostOrderPayload = {
        order,
        orderType,
        postOnly: false, // Market orders should not be post-only
      };

      // Add owner (API key) if available
      if (this.apiKey) {
        postOrder.owner = this.apiKey;
      }

      // Post order to CLOB API
      const url = `${CLOB_HOST}/order`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(postOrder),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logError(`Order placement failed: ${response.status} ${errorText}`);
        return {
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }

      const result = (await response.json()) as {
        success?: boolean;
        orderID?: string;
        order_id?: string;
        orderId?: string;
        status?: string;
        errorMsg?: string;
        [key: string]: unknown;
      };

      // Check for API-level errors
      if (result.success === false || result.errorMsg) {
        logError(`Order placement error: ${result.errorMsg || "Unknown error"}`);
        return {
          error: result.errorMsg || "Order placement failed",
          status: result.status,
        };
      }

      logInfo(`Order placed: ${result.orderID || result.order_id || result.orderId || "unknown"}`);

      // Increment nonce after successful order placement
      this.incrementNonce();

      return {
        orderID: result.orderID || result.order_id || result.orderId,
        status: result.status,
        raw: result,
      };
    } catch (error) {
      logError("Failed to place buy order:", error);
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Place a sell order (used exclusively for emergency unwinds).
   *
   * Callers should pass UNWIND_SELL_PRICE (e.g. $0.01) so the FAK sweeps
   * the entire bid-side of the book regardless of current market price.
   */
  async placeSellOrder(
    tokenId: string,
    price: number,
    size: number,
    orderType: "FOK" | "FAK" | "GTC" | "GTD" = "FAK",
    expiration?: number,
  ): Promise<ClobOrderResponse> {
    try {
      // Conditional token allowance is required for selling shares
      await this.updateBalanceAllowance("CONDITIONAL", tokenId);

      // Round price and size per API requirements (price: 4dp, size: 2dp)
      const roundedPrice = Math.round(price * 10000) / 10000;
      let roundedSize = Math.round(size * 100) / 100;

      // For unwind sells the minimum-value check is skipped intentionally —
      // at $0.01/share the $1 floor would force an unreasonably large size.
      // We sell exactly what we hold.

      // Guard: a zero or negative sell size would submit a worthless order and
      // leave the naked position open. Return an error immediately so the caller
      // throws UnwindFailedError instead of silently doing nothing.
      if (roundedSize <= 0) {
        logError(`placeSellOrder: computed roundedSize=${roundedSize} for size=${size} — refusing to submit zero-size sell`);
        return { error: `Invalid sell size: rounded to ${roundedSize}` };
      }

      // NOTE: The former decimalPlaces while loop has been removed (same IEEE-754
      // issue as placeBuyOrder — see that method's comment). createOrder uses
      // BigInt(Math.round(...)) so the product's float representation is irrelevant.

      const orderArgs: OrderArgs = {
        price: roundedPrice,
        size: roundedSize,
        side: "SELL",
        tokenId,
        expiration: expiration || (orderType === "GTD" ? Math.floor(Date.now() / 1000) + 3600 : 0),
      };

      const order = await this.createOrder(orderArgs);

      const postOrder: PostOrderPayload = {
        order,
        orderType,
        postOnly: false,
      };

      if (this.apiKey) {
        postOrder.owner = this.apiKey;
      }

      const url = `${CLOB_HOST}/order`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postOrder),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logError(`Sell order placement failed: ${response.status} ${errorText}`);
        return { error: `HTTP ${response.status}: ${errorText}` };
      }

      const result = (await response.json()) as {
        success?: boolean;
        orderID?: string;
        order_id?: string;
        orderId?: string;
        status?: string;
        errorMsg?: string;
        [key: string]: unknown;
      };

      if (result.success === false || result.errorMsg) {
        logError(`Sell order placement error: ${result.errorMsg || "Unknown error"}`);
        return {
          error: result.errorMsg || "Sell order placement failed",
          status: result.status,
        };
      }

      logInfo(`Sell order placed: ${result.orderID || result.order_id || result.orderId || "unknown"}`);
      this.incrementNonce();

      return {
        orderID: result.orderID || result.order_id || result.orderId,
        status: result.status,
        raw: result,
      };
    } catch (error) {
      logError("Failed to place sell order:", error);
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Place multiple orders in a single batch request
   * According to https://docs.polymarket.com/developers/CLOB/orders/create-order-batch
   * Supports up to 15 orders per request
   */
  async placeBatchOrders(orders: Array<{
    tokenId: string;
    price: number;
    size: number;
    side: "BUY" | "SELL";
    orderType: "FOK" | "FAK" | "GTC" | "GTD";
    expiration?: number;
  }>): Promise<ClobOrderResponse[]> {
    if (orders.length > 15) {
      logError("Batch orders limited to 15 orders per request");
      return orders.map(() => ({ error: "Batch size exceeds 15 orders" }));
    }

    try {
      // Update conditional token allowances for all tokens in the batch
      await Promise.all(orders.map((o) => this.updateBalanceAllowance("CONDITIONAL", o.tokenId)));

      // Build orders SEQUENTIALLY — each createOrder reads this.nonce, so concurrent
      // calls would assign the same nonce to both orders, causing the second to be
      // rejected by the exchange with a nonce-mismatch error.
      const postOrders: PostOrderPayload[] = [];
      for (const orderArgs of orders) {
        const roundedPrice = Math.round(orderArgs.price * 10000) / 10000;
        let roundedSize = Math.round(orderArgs.size * 100) / 100;

        // Ensure minimum order value
        if (roundedPrice * roundedSize < 1.0) {
          roundedSize = Math.ceil((1.0 / roundedPrice) * 100) / 100;
        }

        // NOTE: decimalPlaces while loop removed — see placeBuyOrder comment.

        const order = await this.createOrder({
          price: roundedPrice,
          size: roundedSize,
          side: orderArgs.side,
          tokenId: orderArgs.tokenId,
          expiration: orderArgs.expiration || 0,
        });
        // Eagerly increment nonce so the next order in the loop gets nonce+1
        this.incrementNonce();

        const postOrder: PostOrderPayload = {
          order,
          orderType: orderArgs.orderType,
          postOnly: false,
        };
        if (this.apiKey) {
          postOrder.owner = this.apiKey;
        }
        postOrders.push(postOrder);
      }

      // Post batch to CLOB API
      const url = `${CLOB_HOST}/orders`; // Note: plural "orders" for batch
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(postOrders),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logError(`Batch order placement failed: ${response.status} ${errorText}`);
        // Nonces were incremented eagerly before this HTTP call. The exchange
        // never saw them, so the local counter is ahead of on-chain state.
        // Reset so the next attempt re-fetches the authoritative nonce.
        this.nonce = null;
        return orders.map(() => ({ error: `HTTP ${response.status}: ${errorText}` }));
      }

      const results = (await response.json()) as Array<{
        success?: boolean;
        orderID?: string;
        order_id?: string;
        orderId?: string;
        status?: string;
        errorMsg?: string;
        [key: string]: unknown;
      }>;

      // Validate the API returned one result per submitted order.
      // A length mismatch means a result is missing and index-based leg assignment
      // (UP=results[0], DOWN=results[1]) would be wrong, potentially targeting the
      // wrong token during an emergency unwind.
      if (results.length !== orders.length) {
        logError(
          `Batch response length mismatch: submitted ${orders.length} orders, ` +
          `received ${results.length} results — cannot safely assign legs`,
        );
        return orders.map(() => ({ error: "Batch response length mismatch" }));
      }

      const mappedResults = results.map((result) => {
        if (result.success === false || result.errorMsg) {
          return {
            error: result.errorMsg || "Order placement failed",
            status: result.status,
          };
        }
        return {
          orderID: result.orderID || result.order_id || result.orderId,
          status: result.status,
          raw: result,
        };
      });

      // Nonces are already incremented eagerly during order creation above.
      return mappedResults;
    } catch (error) {
      // Nonces were incremented eagerly before the HTTP call. If the call threw,
      // the exchange never saw those nonces — the local counter is now ahead of
      // the on-chain state. Reset to null so the next attempt re-fetches the
      // authoritative nonce from the API rather than using a stale local value.
      this.nonce = null;
      logError("Failed to place batch orders:", error);
      return orders.map(() => ({
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  /**
   * Get all open (LIVE) orders for this wallet.
   * Requires L2 API-key auth (POLY_API_KEY / POLY_API_SECRET / POLY_API_PASSPHRASE).
   * Returns an empty array (with a warning) if credentials are not configured.
   */
  async getOpenOrders(): Promise<Array<{ orderID: string; tokenId: string; status: string }>> {
    if (!this.apiKey || !this.apiSecret || !this.apiPassphrase) {
      logWarn("getOpenOrders: L2 API credentials not configured — skipping");
      return [];
    }
    try {
      const path = `/orders?maker=${this.wallet.address}&status=LIVE`;
      const url  = `${CLOB_HOST}${path}`;
      const authHeaders = this.buildL2AuthHeaders("GET", path);
      const response = await fetch(url, { headers: authHeaders });
      if (!response.ok) {
        const body = await response.text();
        logWarn(`getOpenOrders failed: HTTP ${response.status} — ${body}`);
        return [];
      }
      // Handle both bare-array and enveloped responses (e.g. { orders: [...] })
      const raw = (await response.json()) as unknown;
      const data: unknown[] = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { orders?: unknown[] }).orders)
          ? (raw as { orders: unknown[] }).orders
          : [];
      if (data.length === 0 && !Array.isArray(raw)) {
        logWarn("getOpenOrders: unexpected response shape — could not extract order list");
      }
      return (data as Array<Record<string, unknown>>)
        .map((o) => ({
          orderID: (o["orderID"] ?? o["order_id"] ?? "") as string,
          tokenId: (o["tokenId"] ?? o["token_id"] ?? o["asset_id"] ?? "") as string,
          status:  (o["status"] ?? "LIVE") as string,
        }))
        .filter((o) => o.orderID !== "");
    } catch (error) {
      logError("Failed to get open orders:", error);
      return [];
    }
  }

  /**
   * Get order status
   */
  async getOrderStatus(orderId: string): Promise<ClobOrderResponse | null> {
    try {
      const url = `${CLOB_HOST}/order/${orderId}`;
      const response = await fetch(url);

      if (!response.ok) {
        return null;
      }

      const result = (await response.json()) as {
        orderID?: string;
        order_id?: string;
        status?: string;
        [key: string]: unknown;
      };
      return {
        orderID: result.orderID || result.order_id,
        status: result.status,
        raw: result,
      };
    } catch (error) {
      logError("Failed to get order status:", error);
      return null;
    }
  }

  /**
   * Cancel an order.
   *
   * Uses Polymarket L2 API-key authentication (HMAC-SHA256). The cancel endpoint
   * is an off-chain REST action — it does NOT require an EIP-712/EIP-191 wallet
   * signature. Using the wallet signature here would result in a 401 from the API.
   *
   * Requires POLY_API_KEY / POLY_API_SECRET / POLY_API_PASSPHRASE to be set.
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.apiKey || !this.apiSecret || !this.apiPassphrase) {
      logWarn(`Cannot cancel order ${orderId}: L2 API credentials not configured`);
      return false;
    }
    try {
      // Polymarket cancel endpoint: DELETE /order with body {"orderID": "..."}
      // NOT DELETE /order/{id} — that path is for GET (status lookup) only.
      // The request body must also be included in the HMAC signature message.
      const path       = "/order";
      const url        = `${CLOB_HOST}${path}`;
      const bodyStr    = JSON.stringify({ orderID: orderId });
      const authHeaders = this.buildL2AuthHeaders("DELETE", path, bodyStr);

      const response = await fetch(url, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        body: bodyStr,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logError(`cancelOrder failed for ${orderId}: HTTP ${response.status} — ${errorBody}`);
        return false;
      }

      return true;
    } catch (error) {
      logError("Failed to cancel order:", error);
      return false;
    }
  }

  /**
   * Helper: Get decimal places in a number
   */
  private decimalPlaces(x: number): number {
    // Use toFixed(20) to avoid scientific notation (e.g. 1e-7 serialises as "1e-7"
    // with .toString(), which would incorrectly return 0 decimal places)
    const s = Number(x).toFixed(20).replace(/0+$/, "");
    if (!s.includes(".")) return 0;
    return s.split(".")[1]?.length || 0;
  }
}
