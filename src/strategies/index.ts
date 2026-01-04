/**
 * Strategy Registry
 *
 * This file manages all trading strategies.
 * To add a new strategy:
 *
 * 1. Create your strategy file extending BaseStrategy
 * 2. Import it here
 * 3. Register it in the strategyRegistry
 *
 * Example:
 * ```typescript
 * import { MyStrategy } from "./myStrategy";
 *
 * strategyRegistry.set("my-strategy", MyStrategy);
 * ```
 */

import { BaseStrategy } from "./baseStrategy";
import { ExamplePriceThresholdStrategy, ExampleMomentumStrategy } from "./exampleStrategy";
import { InventoryBalancedRebalancingStrategy } from "./inventoryRebalancing";
import { StrategyConfig } from "../interfaces";
import { MarketDataService } from "../services/marketData";
import logger from "../utils/logger";

// Type for strategy constructor
type StrategyConstructor = new (
  config: StrategyConfig,
  marketData: MarketDataService
) => BaseStrategy;

// Registry of available strategies
const strategyRegistry = new Map<string, StrategyConstructor>();

// Register default strategies
registerStrategy("price-threshold", ExamplePriceThresholdStrategy);
registerStrategy("momentum", ExampleMomentumStrategy);
registerStrategy("inventory-rebalancing", InventoryBalancedRebalancingStrategy);

/**
 * Register a new strategy
 */
export function registerStrategy(name: string, strategy: StrategyConstructor): void {
  strategyRegistry.set(name, strategy);
  logger.info(`Registered strategy: ${name}`);
}

/**
 * Get a strategy by name
 */
export function getStrategy(name: string): StrategyConstructor | undefined {
  return strategyRegistry.get(name);
}

/**
 * Get all registered strategy names
 */
export function getRegisteredStrategies(): string[] {
  return Array.from(strategyRegistry.keys());
}

/**
 * Create a strategy instance
 */
export function createStrategy(
  name: string,
  config: StrategyConfig,
  marketData: MarketDataService
): BaseStrategy | null {
  const StrategyClass = strategyRegistry.get(name);
  if (!StrategyClass) {
    logger.error(`Strategy not found: ${name}`);
    return null;
  }
  return new StrategyClass(config, marketData);
}

/**
 * Strategy Manager - manages multiple strategies
 */
export class StrategyManager {
  private strategies: Map<string, BaseStrategy> = new Map();
  private marketData: MarketDataService;

  constructor(marketData: MarketDataService) {
    this.marketData = marketData;
  }

  /**
   * Add a strategy instance
   */
  addStrategy(strategy: BaseStrategy): void {
    this.strategies.set(strategy.getName(), strategy);
    logger.info(`Added strategy: ${strategy.getName()}`);
  }

  /**
   * Remove a strategy
   */
  removeStrategy(name: string): boolean {
    const removed = this.strategies.delete(name);
    if (removed) {
      logger.info(`Removed strategy: ${name}`);
    }
    return removed;
  }

  /**
   * Get a strategy by name
   */
  getStrategy(name: string): BaseStrategy | undefined {
    return this.strategies.get(name);
  }

  /**
   * Get all strategies
   */
  getAllStrategies(): BaseStrategy[] {
    return Array.from(this.strategies.values());
  }

  /**
   * Get enabled strategies
   */
  getEnabledStrategies(): BaseStrategy[] {
    return Array.from(this.strategies.values()).filter((s) => s.isEnabled());
  }

  /**
   * Run all enabled strategies and collect signals
   */
  async runStrategies(): Promise<{ strategy: string; signals: any[] }[]> {
    const results: { strategy: string; signals: any[] }[] = [];

    for (const strategy of this.getEnabledStrategies()) {
      try {
        await strategy.onBeforeAnalysis();
        let result = await strategy.analyze();
        result = await strategy.onAfterAnalysis(result);

        if (result.signals.length > 0) {
          results.push({
            strategy: strategy.getName(),
            signals: result.signals,
          });
          logger.info(
            `Strategy ${strategy.getName()} generated ${result.signals.length} signal(s)`
          );
        }
      } catch (error) {
        logger.error(`Error running strategy ${strategy.getName()}:`, error);
      }
    }

    return results;
  }

  /**
   * Update all strategies with current positions and balance
   */
  updateContext(positions: any[], balance: number): void {
    for (const strategy of this.strategies.values()) {
      strategy.updatePositions(positions);
      strategy.updateBalance(balance);
    }
  }
}

// Re-export BaseStrategy for convenience
export { BaseStrategy } from "./baseStrategy";
export { ExamplePriceThresholdStrategy, ExampleMomentumStrategy } from "./exampleStrategy";
export { InventoryBalancedRebalancingStrategy } from "./inventoryRebalancing";