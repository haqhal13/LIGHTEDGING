// CRITICAL: Initialize runId FIRST before any logger imports
// This ensures all CSV files use the same run ID
import { getRunId } from './utils/runId';
getRunId(); // Initialize runId immediately

import { connectDB, disconnectDB } from "./config/db";
import { ENV } from "./config/env";
import { createClobClient } from "./services/clobClient";
import { MarketDataService } from "./services/marketData";
import { TradeExecutor } from "./services/tradeExecutor";
import { PaperTrader } from "./services/paperTrader";
import { Dashboard } from "./services/dashboard";
import { StrategyManager, BaseStrategy } from "./strategies";
import { TradeSignal } from "./interfaces";
import logger from "./utils/logger";

// Import price stream logger - starts WebSocket connection for live prices
import priceStreamLogger from "./services/priceStreamLogger";
// Import market tracker for dashboard functionality
import marketTracker from "./services/marketTracker";
// Import config watcher for hot-reloading
import { startConfigWatcher, stopConfigWatcher } from "./config/rebalanceConfig";

// Main bot class
export class PolymarketBot {
  private marketData!: MarketDataService;
  private tradeExecutor!: TradeExecutor;
  private paperTrader!: PaperTrader;
  private strategyManager!: StrategyManager;
  private dashboard?: Dashboard;
  private isRunning: boolean = false;
  private isPaperMode: boolean;
  private isWatcherMode: boolean;

  constructor() {
    this.isPaperMode = ENV.PAPER_MODE;
    this.isWatcherMode = ENV.WATCHER_MODE;
  }

  async initialize(): Promise<void> {
    logger.info("=".repeat(50));
    logger.info("LIGHTEDGE POLYMARKET BOT");
    logger.info("=".repeat(50));

    if (this.isWatcherMode) {
      logger.info("Running in WATCHER MODE - Dashboard only, no trades will be executed");
    } else if (this.isPaperMode) {
      logger.paper("Running in PAPER MODE - No real trades will be executed");
    } else {
      logger.warn("Running in LIVE MODE - Real trades will be executed!");
    }

    // Connect to database
    await connectDB();

    // Initialize CLOB client
    const clobClient = await createClobClient();

    // Initialize services
    this.marketData = new MarketDataService(clobClient);
    this.tradeExecutor = new TradeExecutor(clobClient);
    this.paperTrader = new PaperTrader(this.marketData);
    this.strategyManager = new StrategyManager(this.marketData);

    // In watcher mode, use the marketTracker from EDGEBOTPRO for dashboard display
    // This provides real-time price streaming and market tracking
    if (this.isWatcherMode) {
      logger.info("Watcher mode: Using marketTracker for live price dashboard");
      // marketTracker auto-discovers markets via priceStreamLogger WebSocket
      // No need to manually add markets - it discovers them automatically
    } else if (ENV.DASHBOARD_MARKETS) {
      // Non-watcher mode with explicit markets - use old dashboard
      this.dashboard = new Dashboard(this.marketData, this.paperTrader);
      this.dashboard.setUpdateInterval(ENV.DASHBOARD_UPDATE_INTERVAL);
      const conditionIds = ENV.DASHBOARD_MARKETS.split(",").map((id) => id.trim()).filter(Boolean);
      await this.dashboard.addMarkets(conditionIds);
      logger.info(`Dashboard configured with ${conditionIds.length} market(s)`);
    }

    logger.success("Bot initialized successfully");
    logger.info("");

    // Start config file watcher for hot-reloading (paper mode only)
    if (this.isPaperMode && !this.isWatcherMode) {
      startConfigWatcher();
    }

    if (this.isWatcherMode) {
      logger.info("Watcher mode: Dashboard will display live market data");
    } else {
      logger.info("No strategies loaded - waiting for you to add strategies");
      logger.info("See src/strategies/exampleStrategy.ts for examples");
    }
    logger.info("");
  }

  /**
   * Add a strategy to the bot
   */
  addStrategy(strategy: BaseStrategy): void {
    this.strategyManager.addStrategy(strategy);
  }

  /**
   * Remove a strategy from the bot
   */
  removeStrategy(name: string): boolean {
    return this.strategyManager.removeStrategy(name);
  }

  /**
   * Get market data service for strategy use
   */
  getMarketData(): MarketDataService {
    return this.marketData;
  }

  /**
   * Get paper trader for checking paper account
   */
  getPaperTrader(): PaperTrader {
    return this.paperTrader;
  }

  /**
   * Get dashboard instance
   */
  getDashboard(): Dashboard | undefined {
    return this.dashboard;
  }

  /**
   * Add markets to dashboard
   */
  async addDashboardMarkets(conditionIds: string[]): Promise<void> {
    if (this.dashboard) {
      await this.dashboard.addMarkets(conditionIds);
    }
  }

  /**
   * Execute a single trade signal
   */
  async executeTrade(signal: TradeSignal): Promise<void> {
    if (this.isPaperMode) {
      const execution = await this.paperTrader.executeOrder(signal);

      // Report filled paper trades to marketTracker for dashboard display
      if (execution.status === "filled") {
        // Get market info from priceStreamLogger for slug/title
        const currentMarkets = priceStreamLogger.getCurrentMarkets();
        let marketSlug = '';
        let marketTitle = signal.metadata?.title as string || 'Unknown';

        // Find the market that contains this token
        for (const [key, marketInfo] of currentMarkets.entries()) {
          const token = marketInfo.tokens.find((t: any) => t.token_id === signal.tokenId);
          if (token) {
            marketSlug = marketInfo.slug || key;
            marketTitle = marketInfo.question || marketTitle;
            break;
          }
        }

        // Create activity object for marketTracker.processTrade
        const activity = {
          transactionHash: `paper-${execution.id}`, // Mark as paper trade
          asset: signal.tokenId,
          conditionId: signal.conditionId,
          slug: marketSlug,
          eventSlug: marketSlug,
          title: marketTitle,
          size: execution.executedSize.toString(),
          price: execution.executedPrice.toString(),
          usdcSize: (execution.executedSize * execution.executedPrice).toString(),
          side: signal.side,
          outcome: signal.metadata?.outcome as string || 'Unknown',
        };

        await marketTracker.processTrade(activity);
      }
    } else {
      await this.tradeExecutor.executeWithRetry(signal);
    }
  }

  /**
   * Run one cycle of strategy analysis and execution
   */
  async runCycle(): Promise<void> {
    // Update strategy context
    const positions = this.isPaperMode
      ? this.paperTrader.getAllPositions()
      : []; // In live mode, fetch from API

    const balance = this.isPaperMode
      ? this.paperTrader.getBalance()
      : 0; // In live mode, fetch from chain

    this.strategyManager.updateContext(positions, balance);

    // Run all strategies
    const results = await this.strategyManager.runStrategies();

    // Execute signals
    for (const result of results) {
      for (const signal of result.signals) {
        await this.executeTrade(signal);
      }
    }
  }

  /**
   * Start the bot main loop
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Bot is already running");
      return;
    }

    this.isRunning = true;

    // In watcher mode, use marketTracker for live dashboard display
    if (this.isWatcherMode) {
      logger.info("Starting live price dashboard in watcher mode...");
      logger.info("Markets will be auto-discovered from WebSocket price stream");

      // Set display mode to WATCH
      marketTracker.setDisplayMode('WATCH');

      // Run the marketTracker display loop
      while (this.isRunning) {
        try {
          await marketTracker.displayStats();
        } catch (error) {
          // Silently handle display errors
        }
        await this.sleep(ENV.DASHBOARD_UPDATE_INTERVAL);
      }
      return;
    }

    // Normal trading mode
    const enabledStrategies = this.strategyManager.getEnabledStrategies();
    if (enabledStrategies.length === 0) {
      logger.warn("No strategies enabled - bot will run but won't trade");
      logger.info("Add strategies using bot.addStrategy(yourStrategy)");
    }

    logger.info(`Starting bot with ${enabledStrategies.length} enabled strategy(s)`);
    logger.info(`Fetch interval: ${ENV.FETCH_INTERVAL} seconds`);

    // Start dashboard if configured (but not in watcher mode - it's already started)
    if (this.dashboard && !this.isWatcherMode) {
      this.dashboard.start();
    }

    // In paper mode, also show the marketTracker dashboard
    if (this.isPaperMode) {
      marketTracker.setDisplayMode('PAPER');
      logger.info("Paper mode: Dashboard will display live market data and paper trades");
    }

    // Track last dashboard update time
    let lastDashboardUpdate = 0;
    const dashboardInterval = ENV.DASHBOARD_UPDATE_INTERVAL || 5000;

    while (this.isRunning) {
      try {
        await this.runCycle();

        // In paper mode, periodically display the dashboard
        if (this.isPaperMode) {
          const now = Date.now();
          if (now - lastDashboardUpdate >= dashboardInterval) {
            try {
              await marketTracker.displayStats();
              lastDashboardUpdate = now;
            } catch (error) {
              // Silently handle display errors
            }
          }
        }
      } catch (error) {
        logger.error("Error in bot cycle:", error);
      }

      // Wait for next cycle
      await this.sleep(ENV.FETCH_INTERVAL * 1000);
    }
  }

  /**
   * Stop the bot
   */
  async stop(): Promise<void> {
    logger.info("Stopping bot...");
    this.isRunning = false;

    // Stop config file watcher
    stopConfigWatcher();

    // Stop dashboard
    if (this.dashboard) {
      this.dashboard.stop();
    }

    // Print final stats if in paper mode
    if (this.isPaperMode && !this.isWatcherMode) {
      const stats = this.paperTrader.getStats();
      logger.info("");
      logger.info("=".repeat(50));
      logger.info("PAPER TRADING SUMMARY");
      logger.info("=".repeat(50));
      logger.info(`Starting Balance: $${stats.startingBalance.toFixed(2)}`);
      logger.info(`Final Balance:    $${stats.balance.toFixed(2)}`);
      logger.info(`Total PnL:        $${stats.totalPnL.toFixed(2)}`);
      logger.info(`Total Trades:     ${stats.tradeCount}`);
      logger.info(`Win Rate:         ${stats.winRate.toFixed(1)}%`);
      logger.info(`Open Positions:   ${stats.positionCount}`);
      logger.info("=".repeat(50));
    }

    await disconnectDB();
    logger.success("Bot stopped");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Main entry point
async function main(): Promise<void> {
  const bot = new PolymarketBot();

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    await bot.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await bot.stop();
    process.exit(0);
  });

  try {
    await bot.initialize();

    // ============================================
    // ADD YOUR STRATEGIES HERE
    // ============================================

    // Only add trading strategies if NOT in watcher mode
    if (!ENV.WATCHER_MODE) {
      // Use Inventory-Balanced Rebalancing Strategy (reads from inventory-rebalance-config.yaml)
      const { InventoryBalancedRebalancingStrategy } = await import("./strategies/inventoryRebalancing");
      const inventoryRebalancingStrategy = new InventoryBalancedRebalancingStrategy(
        {
          name: "inventory-rebalancing",
          enabled: true,
          parameters: {}, // Config loaded from inventory-rebalance-config.yaml
        },
        bot.getMarketData()
      );
      bot.addStrategy(inventoryRebalancingStrategy);
      logger.info("Loaded Inventory-Balanced Rebalancing Strategy (config: inventory-rebalance-config.yaml)");
    }

    // ============================================

    await bot.start();
  } catch (error) {
    logger.error("Fatal error:", error);
    process.exit(1);
  }
}

// Export for programmatic use
export * from "./interfaces";
export * from "./strategies";
export { MarketDataService } from "./services/marketData";
export { PaperTrader } from "./services/paperTrader";
export { TradeExecutor } from "./services/tradeExecutor";
export { Dashboard } from "./services/dashboard";
export { default as priceStreamLogger } from "./services/priceStreamLogger";
export { default as marketTracker } from "./services/marketTracker";

// Run if called directly
main();
