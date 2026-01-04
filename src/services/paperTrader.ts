import {
  TradeSignal,
  TradeExecution,
  TradeHistory,
  Position,
  PaperAccount
} from "../interfaces";
import { TradeHistoryModel } from "../models/tradeHistory";
import { ENV } from "../config/env";
import logger from "../utils/logger";
import { MarketDataService } from "./marketData";
import { getRunId } from "../utils/runId";
import * as fs from "fs";
import * as path from "path";

export class PaperTrader {
  private account: PaperAccount;
  private marketData: MarketDataService;
  private csvFilePath: string;
  private csvInitialized: boolean = false;

  constructor(marketData: MarketDataService, startingBalance?: number) {
    this.marketData = marketData;
    this.account = {
      balance: startingBalance || ENV.PAPER_BALANCE,
      positions: new Map<string, Position>(),
      tradeHistory: [],
      startingBalance: startingBalance || ENV.PAPER_BALANCE,
      createdAt: new Date(),
    };

    // Initialize CSV file for paper trades
    const logsDir = path.join(process.cwd(), "logs");
    const paperDir = path.join(logsDir, "paper");
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    if (!fs.existsSync(paperDir)) {
      fs.mkdirSync(paperDir, { recursive: true });
    }
    const runId = getRunId();
    this.csvFilePath = path.join(paperDir, `Paper Trades_${runId}.csv`);
    this.initializeCsv();

    logger.paper(`Paper account initialized with $${this.account.balance} USDC`);
  }

  private initializeCsv(): void {
    try {
      const headers = [
        "Timestamp",
        "Date",
        "Time",
        "Trade ID",
        "Side",
        "Market",
        "Outcome",
        "Condition ID",
        "Token ID",
        "Size",
        "Price",
        "USDC Value",
        "Fees",
        "Balance After",
        "Strategy",
        "Status",
      ].join(",");
      fs.writeFileSync(this.csvFilePath, headers + "\n", "utf8");
      this.csvInitialized = true;
      logger.info(`Paper trades CSV initialized: ${this.csvFilePath}`);
    } catch (error) {
      logger.error(`Failed to initialize paper trades CSV: ${error}`);
    }
  }

  private writeTradeToCsv(execution: TradeExecution, signal: TradeSignal): void {
    if (!this.csvInitialized) return;

    try {
      const timestamp = execution.timestamp.toISOString();
      const date = execution.timestamp.toLocaleDateString("en-US");
      const time = execution.timestamp.toLocaleTimeString("en-US");
      const market = (signal.metadata?.title as string) || "Unknown";
      const outcome = (signal.metadata?.outcome as string) || "Unknown";

      const row = [
        timestamp,
        date,
        time,
        execution.id,
        signal.side,
        `"${market.replace(/"/g, '""')}"`,
        outcome,
        signal.conditionId,
        signal.tokenId,
        execution.executedSize.toFixed(4),
        execution.executedPrice.toFixed(4),
        (execution.executedSize * execution.executedPrice).toFixed(2),
        execution.fees.toFixed(4),
        this.account.balance.toFixed(2),
        signal.strategyName,
        execution.status,
      ].join(",");

      fs.appendFileSync(this.csvFilePath, row + "\n", "utf8");
    } catch (error) {
      logger.error(`Failed to write paper trade to CSV: ${error}`);
    }
  }

  async executeOrder(signal: TradeSignal): Promise<TradeExecution> {
    const execution: TradeExecution = {
      id: `paper_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      signal,
      executedPrice: 0,
      executedSize: 0,
      fees: 0,
      status: "pending",
      paperTrade: true,
      timestamp: new Date(),
    };

    try {
      // Get current market price for realistic execution
      const currentPrice = await this.marketData.getPrice(signal.tokenId, signal.side);
      const executePrice = currentPrice || signal.price;

      // Simulate slippage (0.1% - 0.5%)
      const slippage = 1 + (Math.random() * 0.004 + 0.001) * (signal.side === "BUY" ? 1 : -1);
      const finalPrice = executePrice * slippage;

      const cost = finalPrice * signal.size;
      const fees = cost * 0.001; // 0.1% fee simulation

      if (signal.side === "BUY") {
        // Check if we have enough balance
        if (this.account.balance < cost + fees) {
          execution.status = "failed";
          execution.error = `Insufficient balance. Need $${(cost + fees).toFixed(2)}, have $${this.account.balance.toFixed(2)}`;
          logger.paper(`Order failed: ${execution.error}`);
          return execution;
        }

        // Deduct from balance
        this.account.balance -= cost + fees;

        // Update or create position
        const existingPosition = this.account.positions.get(signal.tokenId);
        if (existingPosition) {
          const totalSize = existingPosition.size + signal.size;
          const avgPrice =
            (existingPosition.avgPrice * existingPosition.size +
              finalPrice * signal.size) /
            totalSize;
          existingPosition.size = totalSize;
          existingPosition.avgPrice = avgPrice;
          existingPosition.timestamp = new Date();
        } else {
          const newPosition: Position = {
            conditionId: signal.conditionId,
            tokenId: signal.tokenId,
            title: signal.metadata?.title as string || "Unknown",
            outcome: signal.metadata?.outcome as string || "Unknown",
            size: signal.size,
            avgPrice: finalPrice,
            timestamp: new Date(),
          };
          this.account.positions.set(signal.tokenId, newPosition);
        }
      } else {
        // SELL
        const existingPosition = this.account.positions.get(signal.tokenId);
        if (!existingPosition || existingPosition.size < signal.size) {
          execution.status = "failed";
          execution.error = `Insufficient position. Trying to sell ${signal.size}, have ${existingPosition?.size || 0}`;
          logger.paper(`Order failed: ${execution.error}`);
          return execution;
        }

        // Add to balance
        this.account.balance += cost - fees;

        // Calculate realized PnL
        const realizedPnl = (finalPrice - existingPosition.avgPrice) * signal.size;
        existingPosition.realizedPnl = (existingPosition.realizedPnl || 0) + realizedPnl;

        // Update position
        existingPosition.size -= signal.size;
        if (existingPosition.size <= 0) {
          this.account.positions.delete(signal.tokenId);
        }
      }

      execution.status = "filled";
      execution.executedPrice = finalPrice;
      execution.executedSize = signal.size;
      execution.fees = fees;

      // Save to history
      const history: TradeHistory = {
        marketId: signal.marketId,
        conditionId: signal.conditionId,
        tokenId: signal.tokenId,
        side: signal.side,
        price: finalPrice,
        size: signal.size,
        usdcSize: cost,
        fees,
        strategyName: signal.strategyName,
        paperTrade: true,
        timestamp: new Date(),
      };
      this.account.tradeHistory.push(history);

      // Also save to database for persistence (if connected)
      try {
        const dbModule = await import("../config/db");
        if (dbModule.isDBConnected && dbModule.isDBConnected()) {
          await TradeHistoryModel.create(history);
        }
      } catch (error) {
        // Database not available, skip persistence
      }

      logger.paper(
        `${signal.side} ${signal.size} @ $${finalPrice.toFixed(4)} | ` +
        `Balance: $${this.account.balance.toFixed(2)} | ` +
        `Strategy: ${signal.strategyName}`
      );

      // Write to CSV file
      this.writeTradeToCsv(execution, signal);
    } catch (error) {
      execution.status = "failed";
      execution.error = error instanceof Error ? error.message : "Unknown error";
      logger.error("Paper trade execution error:", error);
    }

    return execution;
  }

  getBalance(): number {
    return this.account.balance;
  }

  getPosition(tokenId: string): Position | undefined {
    return this.account.positions.get(tokenId);
  }

  getAllPositions(): Position[] {
    return Array.from(this.account.positions.values());
  }

  getTradeHistory(): TradeHistory[] {
    return this.account.tradeHistory;
  }

  async getPortfolioValue(): Promise<number> {
    let positionValue = 0;

    for (const position of this.account.positions.values()) {
      const currentPrice = await this.marketData.getMidPrice(position.tokenId);
      if (currentPrice) {
        position.currentPrice = currentPrice;
        position.currentValue = currentPrice * position.size;
        position.cashPnl = (currentPrice - position.avgPrice) * position.size;
        position.percentPnl = ((currentPrice - position.avgPrice) / position.avgPrice) * 100;
        positionValue += position.currentValue;
      }
    }

    return this.account.balance + positionValue;
  }

  getTotalPnL(): number {
    return this.account.balance - this.account.startingBalance +
      this.account.tradeHistory.reduce((sum, t) => sum + (t.side === "SELL" ? t.usdcSize - t.fees : 0), 0);
  }

  getStats(): {
    balance: number;
    startingBalance: number;
    positionCount: number;
    tradeCount: number;
    winRate: number;
    totalPnL: number;
    weightedPnL: number;
    totalValue: number;
    initialValue: number;
  } {
    const trades = this.account.tradeHistory;
    const sellTrades = trades.filter((t) => t.side === "SELL");
    const winningTrades = sellTrades.filter((t) => {
      const buyTrade = trades.find(
        (bt) => bt.tokenId === t.tokenId && bt.side === "BUY" && bt.timestamp < t.timestamp
      );
      return buyTrade && t.price > buyTrade.price;
    });

    // Calculate weighted P&L (from EDGEBOTPRO)
    // Each position's P&L percentage is weighted by its current value
    const { weightedPnL, totalValue, initialValue } = this.calculateWeightedPnL();

    return {
      balance: this.account.balance,
      startingBalance: this.account.startingBalance,
      positionCount: this.account.positions.size,
      tradeCount: trades.length,
      winRate: sellTrades.length > 0 ? (winningTrades.length / sellTrades.length) * 100 : 0,
      totalPnL: this.account.balance - this.account.startingBalance,
      weightedPnL,
      totalValue,
      initialValue,
    };
  }

  /**
   * Calculate weighted portfolio P&L (from EDGEBOTPRO)
   * Weights each position's percentage P&L by its current value
   * This gives a more accurate overall profitability measure where
   * larger positions have proportionally more impact on the result
   */
  calculateWeightedPnL(): { weightedPnL: number; totalValue: number; initialValue: number } {
    let totalValue = 0;
    let initialValue = 0;
    let weightedPnlSum = 0;

    for (const position of this.account.positions.values()) {
      const value = position.currentValue || (position.currentPrice || position.avgPrice) * position.size;
      const initial = position.avgPrice * position.size;
      const pnlPercent = position.percentPnl || 0;

      totalValue += value;
      initialValue += initial;
      weightedPnlSum += value * pnlPercent;
    }

    // Weighted P&L = sum(value * pnl%) / totalValue
    const weightedPnL = totalValue > 0 ? weightedPnlSum / totalValue : 0;

    return { weightedPnL, totalValue, initialValue };
  }

  resetAccount(): void {
    this.account = {
      balance: this.account.startingBalance,
      positions: new Map<string, Position>(),
      tradeHistory: [],
      startingBalance: this.account.startingBalance,
      createdAt: new Date(),
    };
    logger.paper("Paper account reset");
  }
}

export default PaperTrader;
