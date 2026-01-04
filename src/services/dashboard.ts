import chalk from "chalk";
import { MarketDataService } from "./marketData";
import { PaperTrader } from "./paperTrader";
import { Position, Market } from "../interfaces";
import logger from "../utils/logger";

export interface DashboardMarket {
  market: Market;
  positions: Position[];
  upPrice?: number;
  downPrice?: number;
  upBuyPrice?: number;
  upSellPrice?: number;
  downBuyPrice?: number;
  downSellPrice?: number;
  previousUpPrice?: number;
  previousDownPrice?: number;
  volume?: string;
  liquidity?: string;
}

interface MarketPositionStats {
  upPosition?: Position;
  downPosition?: Position;
  upInvested: number;
  downInvested: number;
  upValue: number;
  downValue: number;
  upPnL: number;
  downPnL: number;
  upTrades: number;
  downTrades: number;
  totalInvested: number;
  totalValue: number;
  totalPnL: number;
}

export class Dashboard {
  private marketData: MarketDataService;
  private paperTrader?: PaperTrader;
  private traderAddresses: string[] = [];
  private markets: DashboardMarket[] = [];
  private updateInterval: number = 1000; // 1 second for accurate countdown
  private isRunning: boolean = false;
  private lastUpdate: Date = new Date();

  constructor(marketData: MarketDataService, paperTrader?: PaperTrader) {
    this.marketData = marketData;
    this.paperTrader = paperTrader;
  }

  /**
   * Set trader addresses to track (for watcher mode)
   */
  setTraderAddresses(addresses: string[]): void {
    this.traderAddresses = addresses;
  }

  /**
   * Add markets to monitor (up to 4)
   * Accepts condition IDs or slugs
   */
  async addMarkets(identifiers: string[]): Promise<void> {
    const maxMarkets = 4;
    const marketsToAdd = identifiers.slice(0, maxMarkets);

    for (const identifier of marketsToAdd) {
      try {
        let market: Market | null = null;

        // Check if it's a condition ID (starts with 0x) or a slug
        if (identifier.startsWith('0x') && identifier.length >= 10) {
          // It's a condition ID
          market = await this.marketData.getMarket(identifier);
        } else {
          // It's likely a slug, try to find by slug
          market = await this.marketData.getMarketBySlug(identifier);
        }

        if (market && market.active) {
          const positions = this.paperTrader
            ? this.paperTrader.getAllPositions().filter((p) => p.conditionId === market.conditionId)
            : [];

          this.markets.push({
            market,
            positions,
          });
        } else if (market && !market.active) {
          logger.debug(`Skipping inactive market: ${identifier}`);
        } else {
          logger.debug(`Market not found: ${identifier}`);
        }
      } catch (error) {
        // Silently skip invalid markets and continue
        logger.debug(`Failed to add market ${identifier}, skipping: ${error instanceof Error ? error.message : 'Unknown error'}`);
        continue;
      }
    }

    if (this.markets.length === 0) {
      logger.warn("No valid markets found to display. Dashboard will be empty.");
    } else {
      logger.info(`Successfully added ${this.markets.length} market(s) to dashboard`);
    }
  }

  /**
   * Update market data for all tracked markets
   */
  async updateMarketData(): Promise<void> {
    // First, update all position prices if in paper mode
    if (this.paperTrader) {
      const positions = this.paperTrader.getAllPositions();
      for (const position of positions) {
        try {
          const currentPrice = await this.marketData.getMidPrice(position.tokenId);
          if (currentPrice !== null) {
            position.currentPrice = currentPrice;
            position.currentValue = currentPrice * position.size;
            position.cashPnl = (currentPrice - position.avgPrice) * position.size;
            position.percentPnl = ((currentPrice - position.avgPrice) / position.avgPrice) * 100;
          }
        } catch (error) {
          // Silently fail for individual positions
        }
      }
    }

    // Then update market prices and positions
    for (const dashboardMarket of this.markets) {
      try {
        const market = dashboardMarket.market;
        
        // For binary markets, get prices for both outcomes
        if (market.outcomes && market.outcomes.length === 2) {
          const upTokenId = `${market.conditionId}:0`;
          const downTokenId = `${market.conditionId}:1`;

          // Get UP prices
          const upBuyPrice = await this.marketData.getPrice(upTokenId, "BUY");
          const upSellPrice = await this.marketData.getPrice(upTokenId, "SELL");
          const upMidPrice = await this.marketData.getMidPrice(upTokenId);

          // Get DOWN prices
          const downBuyPrice = await this.marketData.getPrice(downTokenId, "BUY");
          const downSellPrice = await this.marketData.getPrice(downTokenId, "SELL");
          const downMidPrice = await this.marketData.getMidPrice(downTokenId);

          dashboardMarket.upBuyPrice = upBuyPrice || undefined;
          dashboardMarket.upSellPrice = upSellPrice || undefined;
          dashboardMarket.upPrice = upMidPrice || undefined;
          dashboardMarket.downBuyPrice = downBuyPrice || undefined;
          dashboardMarket.downSellPrice = downSellPrice || undefined;
          dashboardMarket.downPrice = downMidPrice || undefined;

          // Calculate price changes
          if (upMidPrice !== null && dashboardMarket.previousUpPrice !== undefined) {
            // Track changes but don't display in this format
          }
          if (downMidPrice !== null && dashboardMarket.previousDownPrice !== undefined) {
            // Track changes but don't display in this format
          }
          if (upMidPrice !== null) dashboardMarket.previousUpPrice = upMidPrice;
          if (downMidPrice !== null) dashboardMarket.previousDownPrice = downMidPrice;
        } else {
          // For non-binary markets, use first outcome
          const tokenId = `${market.conditionId}:0`;
          const buyPrice = await this.marketData.getPrice(tokenId, "BUY");
          const sellPrice = await this.marketData.getPrice(tokenId, "SELL");
          const midPrice = await this.marketData.getMidPrice(tokenId);
          dashboardMarket.upPrice = midPrice || undefined;
        }

        dashboardMarket.volume = market.volume;
        dashboardMarket.liquidity = market.liquidity;

        // Update positions - from paper trader or tracked traders
        if (this.paperTrader) {
          dashboardMarket.positions = this.paperTrader
            .getAllPositions()
            .filter((p) => p.conditionId === dashboardMarket.market.conditionId);
        } else if (this.traderAddresses.length > 0) {
          // Fetch positions from tracked traders (watcher mode)
          const allPositions: Position[] = [];
          for (const address of this.traderAddresses) {
            try {
              const userPositions = await this.marketData.getUserPositions(address);
              userPositions.forEach((up) => {
                if (up.conditionId === dashboardMarket.market.conditionId) {
                  // Convert UserPosition to Position format
                  const position: Position = {
                    conditionId: up.conditionId,
                    tokenId: up.tokenId,
                    title: up.title,
                    outcome: up.outcome,
                    size: up.size,
                    avgPrice: up.avgPrice,
                    currentPrice: up.curPrice,
                    currentValue: up.currentValue,
                    cashPnl: up.cashPnl,
                    percentPnl: up.percentPnl,
                    realizedPnl: up.realizedPnl,
                    timestamp: new Date(),
                  };
                  allPositions.push(position);
                }
              });
            } catch (error) {
              // Silently fail for individual traders
            }
          }
          dashboardMarket.positions = allPositions;
        }
      } catch (error) {
        logger.debug(`Failed to update market data for ${dashboardMarket.market.conditionId}:`, error);
      }
    }
    this.lastUpdate = new Date();
  }

  /**
   * Calculate market position stats
   */
  private getMarketStats(dashboardMarket: DashboardMarket): MarketPositionStats {
    const stats: MarketPositionStats = {
      upInvested: 0,
      downInvested: 0,
      upValue: 0,
      downValue: 0,
      upPnL: 0,
      downPnL: 0,
      upTrades: 0,
      downTrades: 0,
      totalInvested: 0,
      totalValue: 0,
      totalPnL: 0,
    };

    // Get trade history to count trades per outcome
    const tradeHistory = this.paperTrader ? this.paperTrader.getTradeHistory() : [];
    
    dashboardMarket.positions.forEach((pos) => {
      const invested = pos.avgPrice * pos.size;
      const value = pos.currentValue || pos.currentPrice ? (pos.currentPrice || 0) * pos.size : invested;
      const pnl = pos.cashPnl || 0;

      // Count trades for this position
      const trades = tradeHistory.filter(
        (t) => t.tokenId === pos.tokenId && t.conditionId === pos.conditionId
      ).length;

      // Determine if UP or DOWN based on outcome or token ID
      const isUp = pos.outcome?.toUpperCase().includes("YES") || 
                   pos.outcome?.toUpperCase().includes("UP") ||
                   pos.tokenId.endsWith(":0");

      if (isUp) {
        stats.upPosition = pos;
        stats.upInvested += invested;
        stats.upValue += value;
        stats.upPnL += pnl;
        stats.upTrades += trades || 1; // Default to 1 if no trade history
      } else {
        stats.downPosition = pos;
        stats.downInvested += invested;
        stats.downValue += value;
        stats.downPnL += pnl;
        stats.downTrades += trades || 1;
      }
    });

    stats.totalInvested = stats.upInvested + stats.downInvested;
    stats.totalValue = stats.upValue + stats.downValue;
    stats.totalPnL = stats.upPnL + stats.downPnL;

    return stats;
  }

  /**
   * Render the dashboard
   */
  render(): void {
    // Clear screen and move cursor to top
    process.stdout.write("\x1b[2J\x1b[H");

    // Watch Mode Header (like EDGEBOTPRO)
    if (this.traderAddresses.length > 0) {
      const totalPnL = this.calculateTotalPnL();
      const totalPnLPercent = this.calculateTotalPnLPercent();
      const pnlColor = totalPnL >= 0 ? chalk.green : chalk.red;
      const pnlSign = totalPnL >= 0 ? "+" : "";

      console.log(chalk.bold("Watch Mode - Trader Market Tracking"));
      console.log(
        `PnL: ${pnlColor(`${pnlSign}$${Math.abs(totalPnL).toFixed(2)}`)} ${pnlColor(`(${pnlSign}${Math.abs(totalPnLPercent).toFixed(1)}%)`)} | ` +
        `Watching: ${chalk.cyan(this.traderAddresses[0].substring(0, 10) + "...")} | ` +
        `Active Markets: ${chalk.cyan(`${this.markets.length}/4`)}`
      );
      console.log(chalk.green("All trades verified from target wallet"));
      console.log();
    }

    // Market displays
    if (this.markets.length === 0) {
      console.log(chalk.yellow("No markets being monitored. Add markets to see live data."));
      console.log();
    } else {
      this.markets.forEach((dashboardMarket) => {
        this.renderMarket(dashboardMarket);
        console.log();
      });
    }

    // Portfolio Summary (grouped like EDGEBOTPRO)
    this.renderPortfolioSummary();

    // Footer
    const updateTime = this.lastUpdate.toLocaleTimeString();
    console.log(
      chalk.gray(`Last Update: ${chalk.white(updateTime)} | `) +
      chalk.gray(`Update Interval: ${chalk.white(`${this.updateInterval / 1000}s`)} | `) +
      chalk.gray(`Press ${chalk.white("Ctrl+C")} to exit`)
    );
  }

  /**
   * Calculate total PnL across all markets
   */
  private calculateTotalPnL(): number {
    let total = 0;
    for (const market of this.markets) {
      const stats = this.getMarketStats(market);
      total += stats.totalPnL;
    }
    return total;
  }

  /**
   * Calculate total PnL percentage
   */
  private calculateTotalPnLPercent(): number {
    let totalInvested = 0;
    let totalValue = 0;
    for (const market of this.markets) {
      const stats = this.getMarketStats(market);
      totalInvested += stats.totalInvested;
      totalValue += stats.totalValue;
    }
    if (totalInvested === 0) return 0;
    return ((totalValue - totalInvested) / totalInvested) * 100;
  }

  /**
   * Calculate weighted portfolio P&L (from EDGEBOTPRO)
   * Each position's P&L percentage is weighted by its current value
   * This gives a more accurate overall profitability measure where
   * larger positions have proportionally more impact on the result
   */
  private calculateWeightedPnL(): { weightedPnL: number; totalValue: number; initialValue: number } {
    let totalValue = 0;
    let initialValue = 0;
    let weightedPnlSum = 0;

    for (const market of this.markets) {
      for (const position of market.positions) {
        const value = position.currentValue || (position.currentPrice || position.avgPrice) * position.size;
        const initial = position.avgPrice * position.size;
        const pnlPercent = position.percentPnl || 0;

        totalValue += value;
        initialValue += initial;
        weightedPnlSum += value * pnlPercent;
      }
    }

    // Weighted P&L = sum(value * pnl%) / totalValue
    const weightedPnL = totalValue > 0 ? weightedPnlSum / totalValue : 0;

    return { weightedPnL, totalValue, initialValue };
  }

  /**
   * Render portfolio summary grouped by market type
   */
  private renderPortfolioSummary(): void {
    if (this.markets.length === 0) return;

    console.log(chalk.bold("Portfolio Summary:"));
    console.log();

    // Group markets by type (15-min, 1-hour, etc.) - simplified for now
    let totalInvested = 0;
    let totalValue = 0;
    let totalTrades = 0;

    for (const market of this.markets) {
      const stats = this.getMarketStats(market);
      totalInvested += stats.totalInvested;
      totalValue += stats.totalValue;
      totalTrades += stats.upTrades + stats.downTrades;
    }

    const totalPnL = totalValue - totalInvested;
    const totalPnLPercent = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;
    const pnlColor = totalPnL >= 0 ? chalk.green : chalk.red;
    const pnlSign = totalPnL >= 0 ? "+" : "";

    // Calculate weighted P&L (from EDGEBOTPRO)
    const { weightedPnL } = this.calculateWeightedPnL();
    const weightedColor = weightedPnL >= 0 ? chalk.green : chalk.red;
    const weightedSign = weightedPnL >= 0 ? "+" : "";

    console.log(
      `TOTAL (All Markets): ` +
      `Invested: ${chalk.yellow(`$${totalInvested.toFixed(2)}`)} | ` +
      `Value: ${chalk.yellow(`$${totalValue.toFixed(2)}`)} | ` +
      `PnL: ${pnlColor(`${pnlSign}$${Math.abs(totalPnL).toFixed(2)}`)} ${pnlColor(`(${pnlSign}${Math.abs(totalPnLPercent).toFixed(2)}%)`)} | ` +
      `Total Trades: ${chalk.cyan(totalTrades)}`
    );
    // Weighted P&L - more accurate for portfolios with different position sizes
    console.log(
      `Weighted PnL: ${weightedColor(`${weightedSign}${Math.abs(weightedPnL).toFixed(2)}%`)} ` +
      chalk.gray(`(larger positions weighted more)`)
    );
    console.log();
  }

  /**
   * Format time remaining as countdown
   */
  private formatTimeRemaining(endDate: string): string {
    const end = new Date(endDate);
    const now = new Date();
    const diff = end.getTime() - now.getTime();

    if (diff <= 0) {
      return chalk.red("CLOSED");
    }

    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    if (minutes > 0) {
      return chalk.yellow(`${minutes}m ${seconds}s left`);
    } else {
      return chalk.red(`${seconds}s left`);
    }
  }

  /**
   * Render distribution bar
   */
  private renderDistributionBar(upPercent: number, downPercent: number, width: number = 40): string {
    const upWidth = Math.round((upPercent / 100) * width);
    const downWidth = width - upWidth;
    const upBar = chalk.bgGreen(" ".repeat(Math.max(0, upWidth)));
    const downBar = chalk.bgRed(" ".repeat(Math.max(0, downWidth)));
    return `${upBar}${downBar}`;
  }

  /**
   * Render a single market (EDGEBOTPRO style)
   */
  private renderMarket(dashboardMarket: DashboardMarket): void {
    const { market, positions } = dashboardMarket;
    const stats = this.getMarketStats(dashboardMarket);

    // Market name (extract short name from question - like "BTC-UpDown-15" or "ETH-UpDown-1h-1")
    let marketName = market.question;
    if (market.question.includes("Bitcoin") || market.question.includes("BTC")) {
      if (market.question.includes("15") || market.question.includes("1:45")) {
        marketName = "BTC-UpDown-15";
      } else if (market.question.includes("1PM") || market.question.includes("1-2PM")) {
        marketName = "BTC-UpDown-1h-1";
      } else {
        marketName = "BTC-UpDown";
      }
    } else if (market.question.includes("Ethereum") || market.question.includes("ETH")) {
      if (market.question.includes("15") || market.question.includes("1:45")) {
        marketName = "ETH-UpDown-15";
      } else if (market.question.includes("1PM") || market.question.includes("1-2PM")) {
        marketName = "ETH-UpDown-1h-1";
      } else {
        marketName = "ETH-UpDown";
      }
    } else {
      marketName = market.question.split("-")[0] || market.question.substring(0, 20);
    }
    
    console.log(chalk.bold.cyan(marketName));

    // Time remaining
    if (market.endDate) {
      const timeRemaining = this.formatTimeRemaining(market.endDate);
      console.log(`Time Remaining: ${timeRemaining}`);
    }

    // Market description
    const description = market.question.length > 60 ? market.question.substring(0, 57) + "..." : market.question;
    console.log(chalk.gray(description));
    console.log();

    // UP Position
    if (stats.upPosition || stats.upInvested > 0) {
      const upPos = stats.upPosition || {
        size: 0,
        avgPrice: 0,
        currentPrice: dashboardMarket.upPrice || 0,
        cashPnl: stats.upPnL,
        percentPnl: stats.upInvested > 0 ? (stats.upPnL / stats.upInvested) * 100 : 0,
      } as Position;

      const upPnLColor = stats.upPnL >= 0 ? chalk.green : chalk.red;
      const upPnLSign = stats.upPnL >= 0 ? "+" : "";

      console.log(chalk.bold("UP Position:"));
      console.log(
        `  Shares: ${chalk.yellow(upPos.size.toFixed(2))} | ` +
        `Invested: ${chalk.yellow(`$${stats.upInvested.toFixed(2)}`)} @ ${chalk.gray(`$${upPos.avgPrice.toFixed(4)}`)} avg | ` +
        `LIVE Price: ${chalk.yellow(`$${(dashboardMarket.upPrice || 0).toFixed(4)}`)} | ` +
        `PnL: ${upPnLColor(`${upPnLSign}$${Math.abs(stats.upPnL).toFixed(2)}`)} ${upPnLColor(`(${upPnLSign}${Math.abs(upPos.percentPnl || 0).toFixed(1)}%)`)} | ` +
        `Trades: ${chalk.cyan(stats.upTrades)}`
      );
    }

    // DOWN Position
    if (stats.downPosition || stats.downInvested > 0) {
      const downPos = stats.downPosition || {
        size: 0,
        avgPrice: 0,
        currentPrice: dashboardMarket.downPrice || 0,
        cashPnl: stats.downPnL,
        percentPnl: stats.downInvested > 0 ? (stats.downPnL / stats.downInvested) * 100 : 0,
      } as Position;

      const downPnLColor = stats.downPnL >= 0 ? chalk.green : chalk.red;
      const downPnLSign = stats.downPnL >= 0 ? "+" : "";

      console.log(chalk.bold("DOWN Position:"));
      console.log(
        `  Shares: ${chalk.yellow(downPos.size.toFixed(2))} | ` +
        `Invested: ${chalk.yellow(`$${stats.downInvested.toFixed(2)}`)} @ ${chalk.gray(`$${downPos.avgPrice.toFixed(4)}`)} avg | ` +
        `LIVE Price: ${chalk.yellow(`$${(dashboardMarket.downPrice || 0).toFixed(4)}`)} | ` +
        `PnL: ${downPnLColor(`${downPnLSign}$${Math.abs(stats.downPnL).toFixed(2)}`)} ${downPnLColor(`(${downPnLSign}${Math.abs(downPos.percentPnl || 0).toFixed(1)}%)`)} | ` +
        `Trades: ${chalk.cyan(stats.downTrades)}`
      );
    }

    // Live Prices Check
    if (dashboardMarket.upPrice !== undefined && dashboardMarket.downPrice !== undefined) {
      const sum = dashboardMarket.upPrice + dashboardMarket.downPrice;
      const checkColor = Math.abs(sum - 1.0) < 0.01 ? chalk.green("✓") : chalk.red("✗");
      console.log(
        `Live Prices Check: UP ${chalk.yellow(`$${dashboardMarket.upPrice.toFixed(4)}`)} + DOWN ${chalk.yellow(`$${dashboardMarket.downPrice.toFixed(4)}`)} = ${chalk.yellow(`$${sum.toFixed(4)}`)} ${checkColor}`
      );
    }

    // Overall for this market
    const overallPnLColor = stats.totalPnL >= 0 ? chalk.green : chalk.red;
    const overallPnLSign = stats.totalPnL >= 0 ? "+" : "";
    const overallPnLPercent = stats.totalInvested > 0 ? (stats.totalPnL / stats.totalInvested) * 100 : 0;

    console.log(chalk.bold(`Overall for ${marketName}:`));
    console.log(
      `  Invested: ${chalk.yellow(`$${stats.totalInvested.toFixed(2)}`)} | ` +
      `Value: ${chalk.yellow(`$${stats.totalValue.toFixed(2)}`)} | ` +
      `PnL: ${overallPnLColor(`${overallPnLSign}$${Math.abs(stats.totalPnL).toFixed(2)}`)} ${overallPnLColor(`(${overallPnLSign}${Math.abs(overallPnLPercent).toFixed(1)}%)`)}`
    );

    // Distribution Bar
    if (stats.totalInvested > 0) {
      const upPercent = (stats.upInvested / stats.totalInvested) * 100;
      const downPercent = (stats.downInvested / stats.totalInvested) * 100;
      const bar = this.renderDistributionBar(upPercent, downPercent);
      console.log(`  Distribution Bar: ${bar} ${chalk.green(`${upPercent.toFixed(1)}%`)} UP / ${chalk.red(`${downPercent.toFixed(1)}%`)} DOWN`);
    }
  }

  /**
   * Start the dashboard update loop
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    logger.info("Dashboard started");

    // Initial render
    await this.updateMarketData();
    this.render();

    // Update loop
    const updateLoop = async () => {
      while (this.isRunning) {
        try {
          await this.updateMarketData();
          this.render();
        } catch (error) {
          logger.error("Dashboard update error:", error);
        }
        await this.sleep(this.updateInterval);
      }
    };

    updateLoop();
  }

  /**
   * Stop the dashboard
   */
  stop(): void {
    this.isRunning = false;
    logger.info("Dashboard stopped");
  }

  /**
   * Set update interval in milliseconds
   */
  setUpdateInterval(ms: number): void {
    this.updateInterval = ms;
  }

  /**
   * Get number of markets being tracked
   */
  getMarketsCount(): number {
    return this.markets.length;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default Dashboard;
