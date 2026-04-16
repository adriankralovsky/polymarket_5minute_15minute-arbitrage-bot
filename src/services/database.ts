/**
 * MongoDB service for trade records and market data persistence
 */

import { MongoClient, Db, Collection } from "mongodb";
import type { TradeRecord, MarketDataRecord } from "../types";
import { logInfo, logError, logWarn, logDebug } from "../utils/logger";
import { getConfig } from "../config";

export class DatabaseService {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private tradesCollection: Collection<TradeRecord> | null = null;
  private marketsCollection: Collection<MarketDataRecord> | null = null;
  private isConnected = false;
  private connectionCheckInterval: NodeJS.Timeout | null = null;

  /**
   * Connect to MongoDB
   */
  async connect(): Promise<void> {
    if (this.isConnected && this.db) {
      return;
    }

    const config = getConfig();
    try {
      // Configure client to avoid session expiration issues
      this.client = new MongoClient(config.mongoUri, {
        // Disable implicit sessions for simple operations
        // This prevents session expiration errors
        maxPoolSize: 10,
        minPoolSize: 2,
        maxIdleTimeMS: 30000,
        serverSelectionTimeoutMS: 5000,
      });
      await this.client.connect();
      this.db = this.client.db(config.mongoDbName);
      this.tradesCollection = this.db.collection<TradeRecord>("trades");
      this.marketsCollection = this.db.collection<MarketDataRecord>("markets");

      // Create indexes
      await this.tradesCollection.createIndex({ timestamp: -1 });
      await this.tradesCollection.createIndex({ market5_id: 1, market15_id: 1 });
      await this.marketsCollection.createIndex({ end_time: -1 });
      await this.marketsCollection.createIndex({ market_id: 1 }, { unique: true });

      this.isConnected = true;
      logInfo("Connected to MongoDB");
      
      // Start connection health check
      this.startConnectionHealthCheck();
    } catch (error) {
      logError("Failed to connect to MongoDB:", error);
      throw error;
    }
  }

  /**
   * Start periodic connection health check
   */
  private startConnectionHealthCheck(): void {
    // Check connection health every 30 seconds
    this.connectionCheckInterval = setInterval(async () => {
      if (this.client && this.db) {
        try {
          await this.db.admin().ping();
        } catch (error) {
          logWarn("MongoDB connection health check failed, reconnecting...");
          this.isConnected = false;
          try {
            await this.connect();
          } catch (reconnectError) {
            logError("Failed to reconnect to MongoDB:", reconnectError);
          }
        }
      }
    }, 30000); // 30 seconds
  }

  /**
   * Disconnect from MongoDB
   */
  async disconnect(): Promise<void> {
    if (this.connectionCheckInterval) {
      clearInterval(this.connectionCheckInterval);
      this.connectionCheckInterval = null;
    }
    if (this.client) {
      await this.client.close();
      this.isConnected = false;
      logInfo("Disconnected from MongoDB");
    }
  }

  /**
   * Ensure connection is active, reconnect if needed
   */
  private async ensureConnection(): Promise<void> {
    // Trust isConnected — the 30-second health-check interval handles failures.
    // Do NOT ping on every call: at 100+ WebSocket ticks/sec that queues
    // thousands of async round-trips, each holding a large marketRecord in
    // memory, causing an OOM crash within minutes.
    if (!this.isConnected || !this.client || !this.db) {
      logWarn("MongoDB connection lost, reconnecting...");
      await this.connect();
    }
  }

  /**
   * Store trade record (requirement 8.1)
   * Handles session errors gracefully with retry logic
   */
  async storeTrade(trade: TradeRecord): Promise<void> {
    const maxRetries = 3;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      try {
        // Ensure connection is active
        await this.ensureConnection();

        if (!this.tradesCollection) {
          throw new Error("Database not connected");
        }

        // Don't use sessions for simple operations to avoid expiration issues
        await this.tradesCollection.insertOne(trade);
        logDebug(`Stored trade record: ${trade._id || "new"}`);
        return; // Success, exit retry loop
      } catch (error: any) {
        retryCount++;
        
        // Check if it's a session error
        if (error?.message?.includes("session") || error?.name === "MongoExpiredSessionError") {
          logWarn(`MongoDB session error (attempt ${retryCount}/${maxRetries}), reconnecting...`);
          this.isConnected = false;
          
          // Wait a bit before retrying
          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
          
          if (retryCount >= maxRetries) {
            logError("Failed to store trade record after retries:", error);
            throw error; // Trade records are more critical, so throw
          }
          continue; // Retry
        } else {
          // Non-session error
          logError("Failed to store trade record:", error);
          throw error;
        }
      }
    }
  }

  /**
   * Store or update market data (requirement 8.2)
   * Handles session errors gracefully with retry logic
   */
  async storeMarketData(market: MarketDataRecord): Promise<void> {
    const maxRetries = 3;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      try {
        // Ensure connection is active
        await this.ensureConnection();

        if (!this.marketsCollection) {
          throw new Error("Database not connected");
        }

        const now = Date.now();
        const update: Partial<MarketDataRecord> = {
          ...market,
          updated_at: now,
        };

        // Don't use sessions for simple operations to avoid expiration issues
        await this.marketsCollection.updateOne(
          { market_id: market.market_id },
          { $set: update },
          { upsert: true },
        );
        logDebug(`Stored market data: ${market.market_id}`);
        return; // Success, exit retry loop
      } catch (error: any) {
        retryCount++;
        
        // Check if it's a session error
        if (error?.message?.includes("session") || error?.name === "MongoExpiredSessionError") {
          logWarn(`MongoDB session error (attempt ${retryCount}/${maxRetries}), reconnecting...`);
          this.isConnected = false;
          
          // Wait a bit before retrying
          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
          
          if (retryCount >= maxRetries) {
            logError("Failed to store market data after retries:", error);
            // Don't throw - this is non-critical, just log the error
            return;
          }
          continue; // Retry
        } else {
          // Non-session error, log and return (don't throw for non-critical operations)
          logError("Failed to store market data:", error);
          return; // Don't retry for non-session errors
        }
      }
    }
  }

  /**
   * Get market data by ID
   */
  async getMarketData(marketId: string): Promise<MarketDataRecord | null> {
    if (!this.marketsCollection) {
      throw new Error("Database not connected");
    }

    try {
      return await this.marketsCollection.findOne({ market_id: marketId });
    } catch (error) {
      logError("Failed to get market data:", error);
      return null;
    }
  }

  /**
   * Get recent trades
   */
  async getRecentTrades(limit = 100): Promise<TradeRecord[]> {
    if (!this.tradesCollection) {
      throw new Error("Database not connected");
    }

    try {
      return await this.tradesCollection
        .find({})
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
    } catch (error) {
      logError("Failed to get recent trades:", error);
      return [];
    }
  }

  /**
   * Get markets by end time range
   */
  async getMarketsByEndTime(
    startTime: number,
    endTime: number,
  ): Promise<MarketDataRecord[]> {
    if (!this.marketsCollection) {
      throw new Error("Database not connected");
    }

    try {
      return await this.marketsCollection
        .find({
          end_time: { $gte: startTime, $lte: endTime },
        })
        .sort({ end_time: 1 })
        .toArray();
    } catch (error) {
      logError("Failed to get markets by end time:", error);
      return [];
    }
  }
}
