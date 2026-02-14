/**
 * MongoDB service for trade records and market data persistence
 */

import { MongoClient, Db, Collection } from "mongodb";
import type { TradeRecord, MarketDataRecord } from "../types";
import { logInfo, logError, logWarn } from "../utils/logger";
import { getConfig } from "../config";

export class DatabaseService {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private tradesCollection: Collection<TradeRecord> | null = null;
  private marketsCollection: Collection<MarketDataRecord> | null = null;
  private isConnected = false;

  /**
   * Connect to MongoDB
   */
  async connect(): Promise<void> {
    if (this.isConnected && this.db) {
      return;
    }

    const config = getConfig();
    try {
      this.client = new MongoClient(config.mongoUri);
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
    } catch (error) {
      logError("Failed to connect to MongoDB:", error);
      throw error;
    }
  }

  /**
   * Disconnect from MongoDB
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.isConnected = false;
      logInfo("Disconnected from MongoDB");
    }
  }

  /**
   * Store trade record (requirement 8.1)
   */
  async storeTrade(trade: TradeRecord): Promise<void> {
    if (!this.tradesCollection) {
      throw new Error("Database not connected");
    }

    try {
      await this.tradesCollection.insertOne(trade);
      logDebug(`Stored trade record: ${trade._id || "new"}`);
    } catch (error) {
      logError("Failed to store trade record:", error);
      throw error;
    }
  }

  /**
   * Store or update market data (requirement 8.2)
   */
  async storeMarketData(market: MarketDataRecord): Promise<void> {
    if (!this.marketsCollection) {
      throw new Error("Database not connected");
    }

    try {
      const now = Date.now();
      const update: Partial<MarketDataRecord> = {
        ...market,
        updated_at: now,
      };

      await this.marketsCollection.updateOne(
        { market_id: market.market_id },
        { $set: update },
        { upsert: true },
      );
      logDebug(`Stored market data: ${market.market_id}`);
    } catch (error) {
      logError("Failed to store market data:", error);
      throw error;
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
