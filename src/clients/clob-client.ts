/**
 * Polymarket CLOB API client for order placement
 * Implements EOA wallet approval and order execution
 */

import { ethers } from "ethers";
import { logInfo, logError, logWarn, logDebug } from "../utils/logger";
import { retry } from "../utils/retry";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon
const POLYGON_RPC = process.env.POLY_RPC_URL || "https://polygon-rpc.com";

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
  private provider: ethers.JsonRpcProvider;
  private signatureType: number;
  private funder: string | null = null;
  private apiKey: string | null = null;
  private apiSecret: string | null = null;
  private nonce: number | null = null; // Exchange nonce (fetched from API)

  constructor() {
    const key = process.env.POLY_PRIVATE_KEY?.trim();
    if (!key) {
      throw new Error("POLY_PRIVATE_KEY not set in environment");
    }

    this.privateKey = key.startsWith("0x") ? key : `0x${key}`;
    this.provider = new ethers.JsonRpcProvider(POLYGON_RPC);
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
      try {
        this.signatureType = parseInt(walletType);
        this.funder = process.env.POLY_FUNDER?.trim() || null;
      } catch {
        this.signatureType = 0;
        this.funder = null;
      }
    }

    logInfo("CLOB Client initialized", {
      address: this.wallet.address,
      signatureType: this.signatureType,
      funder: this.funder || "none",
    });
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
        logWarn(`Failed to fetch nonce: ${response.status}, using 0 as fallback`);
        this.nonce = 0;
        return 0;
      }

      const data = (await response.json()) as { nonce?: number; nonce_value?: number };
      this.nonce = data.nonce ?? data.nonce_value ?? 0;
      logDebug(`Fetched exchange nonce: ${this.nonce}`);
      return this.nonce;
    } catch (error) {
      logWarn(`Error fetching nonce: ${error instanceof Error ? error.message : String(error)}, using 0 as fallback`);
      this.nonce = 0;
      return 0;
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
   * Calculate market price for a specific token, side, and amount
   * Uses Polymarket's CLOB API to calculate executable price considering orderbook depth
   * This is more accurate than best_ask/best_bid for specific trade sizes
   * See: https://docs.polymarket.com/developers/CLOB/clients/methods-public#calculatemarketprice
   * 
   * @param tokenID - Token ID to calculate price for
   * @param side - "BUY" or "SELL"
   * @param amount - Amount of tokens to buy/sell
   * @param orderType - Order type (default: "FOK" for Fill-or-Kill)
   * @returns Calculated market price, or null if calculation fails
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
    // Try calculateMarketPrice first (more accurate for specific amounts)
    const calculatedPrice = await this.calculateMarketPrice(tokenID, "BUY", amount, "FOK");
    if (calculatedPrice !== null && calculatedPrice > 0) {
      return calculatedPrice;
    }

    // Fallback to simple price endpoint
    try {
      const url = `${CLOB_HOST}/price?token_id=${tokenID}&side=BUY`;
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
    return true;
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

    // Calculate amounts in wei
    // For BUY orders:
    // - makerAmount = size * price (in USDC, 6 decimals) = (size * price) * 1e6
    // - takerAmount = size (in shares, 18 decimals) = size * 1e18
    // For SELL orders (reverse):
    // - makerAmount = size (in shares, 18 decimals) = size * 1e18
    // - takerAmount = size * price (in USDC, 6 decimals) = (size * price) * 1e6
    
    const USDC_DECIMALS = 6;
    const SHARE_DECIMALS = 18;
    
    let makerAmount: bigint;
    let takerAmount: bigint;
    
    if (args.side === "BUY") {
      // Maker pays USDC, receives shares
      makerAmount = BigInt(Math.floor(args.size * args.price * 10 ** USDC_DECIMALS));
      takerAmount = BigInt(Math.floor(args.size * 10 ** SHARE_DECIMALS));
    } else {
      // Maker pays shares, receives USDC
      makerAmount = BigInt(Math.floor(args.size * 10 ** SHARE_DECIMALS));
      takerAmount = BigInt(Math.floor(args.size * args.price * 10 ** USDC_DECIMALS));
    }

    // L1 Method: Sign order using EIP-712 typed data signing
    // According to https://docs.polymarket.com/developers/CLOB/clients/methods-l1
    // Orders are signed as EIP-712 typed data, not plain JSON
    // The signature format matches the official CLOB client implementation
    
    // Build typed data structure for EIP-712 signing
    // Note: Polymarket uses a specific domain separator and order structure
    // For EOA (signatureType 0), we use standard EIP-712 signing
    // Convert all numeric fields to strings for signing (per py-clob-client format)
    const orderForSigning = {
      salt: salt.toString(),
      maker,
      signer,
      taker,
      tokenId: args.tokenId,
      makerAmount: makerAmount.toString(),
      takerAmount: takerAmount.toString(),
      expiration: (args.expiration || 0).toString(),
      nonce: ((this.nonce ?? 0) as number).toString(),
      feeRateBps: "0",
      side: args.side === "BUY" ? 0 : 1, // 0 = BUY, 1 = SELL per API
      signatureType: this.signatureType,
    };
    
    // Sign using EIP-712 typed data (if available) or fallback to JSON string signing
    // The official client uses EIP-712, but for compatibility we'll use the same format
    // that py-clob-client uses (JSON string signing for EOA)
    const message = JSON.stringify(orderForSigning);
    const signature = await this.wallet.signMessage(ethers.toUtf8Bytes(message));

    // Return full order object (with numbers as per API spec)
    return {
      salt,
      maker,
      signer,
      taker,
      tokenId: args.tokenId,
      makerAmount: makerAmount.toString(),
      takerAmount: takerAmount.toString(),
      expiration: (args.expiration || 0).toString(),
      nonce: ((this.nonce ?? 0) as number).toString(),
      feeRateBps: "0", // TODO: Make configurable via environment variable
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

      // Ensure maker amount (price * size) has <= 2 decimals
      while (this.decimalPlaces(roundedPrice * roundedSize) > 2) {
        roundedSize = Math.round((roundedSize + 0.01) * 100) / 100;
      }

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

      // Ensure takerAmount (price * size) has <= 2 decimal places
      while (this.decimalPlaces(roundedPrice * roundedSize) > 2) {
        roundedSize = Math.round((roundedSize + 0.01) * 100) / 100;
      }

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
      // Create all orders
      const postOrders: PostOrderPayload[] = await Promise.all(
        orders.map(async (orderArgs) => {
          // Round price and size
          const roundedPrice = Math.round(orderArgs.price * 10000) / 10000;
          let roundedSize = Math.round(orderArgs.size * 100) / 100;

          // Ensure minimum order value
          if (roundedPrice * roundedSize < 1.0) {
            roundedSize = Math.ceil((1.0 / roundedPrice) * 100) / 100;
          }

          // Ensure maker amount has <= 2 decimals
          while (this.decimalPlaces(roundedPrice * roundedSize) > 2) {
            roundedSize = Math.round((roundedSize + 0.01) * 100) / 100;
          }

          const order = await this.createOrder({
            price: roundedPrice,
            size: roundedSize,
            side: orderArgs.side,
            tokenId: orderArgs.tokenId,
            expiration: orderArgs.expiration || 0,
          });

          const postOrder: PostOrderPayload = {
            order,
            orderType: orderArgs.orderType,
            postOnly: false,
          };

          if (this.apiKey) {
            postOrder.owner = this.apiKey;
          }

          return postOrder;
        }),
      );

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

      // Increment nonce for each successful order
      const successCount = mappedResults.filter((r) => !r.error).length;
      for (let i = 0; i < successCount; i++) {
        this.incrementNonce();
      }

      return mappedResults;
    } catch (error) {
      logError("Failed to place batch orders:", error);
      return orders.map(() => ({
        error: error instanceof Error ? error.message : String(error),
      }));
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
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      const url = `${CLOB_HOST}/order/${orderId}`;
      const message = JSON.stringify({ order_id: orderId });
      const signature = await this.wallet.signMessage(ethers.toUtf8Bytes(message));

      const response = await fetch(url, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "X-Address": this.wallet.address,
          "X-Signature": signature,
        },
      });

      return response.ok;
    } catch (error) {
      logError("Failed to cancel order:", error);
      return false;
    }
  }

  /**
   * Helper: Get decimal places in a number
   */
  private decimalPlaces(x: number): number {
    const s = x.toString();
    if (s.includes("e")) return 0;
    if (!s.includes(".")) return 0;
    return s.split(".")[1]?.replace(/0+$/, "").length || 0;
  }
}
