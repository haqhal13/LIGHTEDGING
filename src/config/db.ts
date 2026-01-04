import mongoose from "mongoose";
import { ENV } from "./env";
import logger from "../utils/logger";

let isConnected = false;

export async function connectDB(): Promise<boolean> {
  // In paper mode, MongoDB is optional
  if (ENV.PAPER_MODE || ENV.WATCHER_MODE) {
    try {
      await mongoose.connect(ENV.MONGO_URI, {
        serverSelectionTimeoutMS: 2000, // 2 second timeout
      });
      isConnected = true;
      logger.success("Connected to MongoDB");
      return true;
    } catch (error) {
      logger.warn("MongoDB not available - continuing without database (paper mode)");
      logger.info("Trade history will not be persisted. Start MongoDB to enable persistence.");
      isConnected = false;
      return false;
    }
  }

  // In live mode, MongoDB is required
  try {
    await mongoose.connect(ENV.MONGO_URI);
    isConnected = true;
    logger.success("Connected to MongoDB");
    return true;
  } catch (error) {
    logger.error("MongoDB connection error:", error);
    logger.error("Database is required for live trading mode");
    process.exit(1);
  }
}

export function isDBConnected(): boolean {
  return isConnected;
}

export async function disconnectDB(): Promise<void> {
  if (isConnected) {
    try {
      await mongoose.disconnect();
      logger.success("Disconnected from MongoDB");
      isConnected = false;
    } catch (error) {
      logger.error("MongoDB disconnect error:", error);
    }
  }
}

export default connectDB;
