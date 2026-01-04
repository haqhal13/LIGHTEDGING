import { TradeSignal, StrategyConfig, StrategyResult, Market, Position } from "../interfaces";
import { MarketDataService } from "../services/marketData";
import logger from "../utils/logger";

/**
 * Base Strategy Class
 *
 * Extend this class to create your own trading strategies.
 *
 * Example:
 * ```typescript
 * import { BaseStrategy } from "./baseStrategy";
 *
 * export class MyStrategy extends BaseStrategy {
 *   async analyze(): Promise<StrategyResult> {
 *     const signals: TradeSignal[] = [];
 *
 *     // Your strategy logic here
 *     // Use this.marketData to fetch market information
 *     // Use this.positions to check current positions
 *     // Use this.config.parameters for your strategy parameters
 *
 *     return { signals };
 *   }
 * }
 * ```
 */
export abstract class BaseStrategy {
  protected config: StrategyConfig;
  protected marketData: MarketDataService;
  protected positions: Position[];
  protected balance: number;

  constructor(
    config: StrategyConfig,
    marketData: MarketDataService,
    positions: Position[] = [],
    balance: number = 0
  ) {
    this.config = config;
    this.marketData = marketData;
    this.positions = positions;
    this.balance = balance;
  }

  /**
   * Main analysis method - implement this in your strategy
   * Should return trade signals based on your strategy logic
   */
  abstract analyze(): Promise<StrategyResult>;

  /**
   * Called before each analysis cycle
   * Override to add initialization logic
   */
  async onBeforeAnalysis(): Promise<void> {
    // Override in subclass if needed
  }

  /**
   * Called after signals are generated
   * Override to add post-processing logic
   */
  async onAfterAnalysis(result: StrategyResult): Promise<StrategyResult> {
    return result;
  }

  /**
   * Update current positions
   */
  updatePositions(positions: Position[]): void {
    this.positions = positions;
  }

  /**
   * Update current balance
   */
  updateBalance(balance: number): void {
    this.balance = balance;
  }

  /**
   * Get strategy name
   */
  getName(): string {
    return this.config.name;
  }

  /**
   * Check if strategy is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Enable/disable strategy
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /**
   * Get strategy parameters
   */
  getParameters(): Record<string, unknown> {
    return this.config.parameters;
  }

  /**
   * Update strategy parameters
   */
  setParameters(params: Record<string, unknown>): void {
    this.config.parameters = { ...this.config.parameters, ...params };
  }

  /**
   * Helper: Create a buy signal
   */
  protected createBuySignal(
    market: Market,
    tokenId: string,
    price: number,
    size: number,
    metadata?: Record<string, unknown>
  ): TradeSignal {
    return {
      marketId: market.id,
      conditionId: market.conditionId,
      tokenId,
      side: "BUY",
      price,
      size,
      strategyName: this.config.name,
      timestamp: new Date(),
      metadata: {
        title: market.question,
        ...metadata,
      },
    };
  }

  /**
   * Helper: Create a sell signal
   */
  protected createSellSignal(
    market: Market,
    tokenId: string,
    price: number,
    size: number,
    metadata?: Record<string, unknown>
  ): TradeSignal {
    return {
      marketId: market.id,
      conditionId: market.conditionId,
      tokenId,
      side: "SELL",
      price,
      size,
      strategyName: this.config.name,
      timestamp: new Date(),
      metadata: {
        title: market.question,
        ...metadata,
      },
    };
  }

  /**
   * Helper: Get position for a token
   */
  protected getPosition(tokenId: string): Position | undefined {
    return this.positions.find((p) => p.tokenId === tokenId);
  }

  /**
   * Helper: Check if we have a position
   */
  protected hasPosition(tokenId: string): boolean {
    return this.positions.some((p) => p.tokenId === tokenId && p.size > 0);
  }

  /**
   * Helper: Calculate position size based on risk
   */
  protected calculatePositionSize(
    price: number,
    riskPercent: number = 2
  ): number {
    const riskAmount = this.balance * (riskPercent / 100);
    return Math.floor(riskAmount / price);
  }

  /**
   * Helper: Log strategy message
   */
  protected log(...args: unknown[]): void {
    logger.info(`[${this.config.name}]`, ...args);
  }
}

export default BaseStrategy;
