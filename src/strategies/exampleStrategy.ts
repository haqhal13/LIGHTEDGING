/**
 * EXAMPLE STRATEGY - For reference only
 *
 * This is a simple example strategy to show you how to create your own.
 * DO NOT use this for actual trading - it's just for demonstration.
 *
 * Delete this file and create your own strategies based on your research.
 */

import { BaseStrategy } from "./baseStrategy";
import { StrategyResult, Market } from "../interfaces";

/**
 * Example: Simple Price Threshold Strategy
 *
 * This strategy looks for markets where the price is below a threshold
 * and generates a buy signal.
 *
 * Parameters:
 * - priceThreshold: Buy if price is below this (default: 0.30)
 * - positionSize: How much to buy (default: 10)
 */
export class ExamplePriceThresholdStrategy extends BaseStrategy {
  async analyze(): Promise<StrategyResult> {
    const signals: any[] = [];

    // Get strategy parameters with defaults
    const priceThreshold = (this.config.parameters.priceThreshold as number) || 0.30;
    const positionSize = (this.config.parameters.positionSize as number) || 10;

    this.log(`Analyzing markets with threshold: ${priceThreshold}`);

    // Get active markets
    const markets = await this.marketData.getMarkets(50, true);

    for (const market of markets) {
      // Skip if we already have a position
      // Note: In a real strategy, you'd have token IDs, not just condition IDs
      // This is simplified for demonstration

      // Parse outcome prices
      const prices = market.outcomePrices?.map((p) => parseFloat(p)) || [];

      for (let i = 0; i < prices.length; i++) {
        const price = prices[i];

        // Check if price is below threshold
        if (price > 0 && price < priceThreshold) {
          this.log(`Found opportunity: ${market.question} @ $${price.toFixed(4)}`);

          // In a real implementation, you'd get the actual token ID
          // This is just an example structure
          // signals.push(this.createBuySignal(market, tokenId, price, positionSize));
        }
      }
    }

    return { signals };
  }
}

/**
 * Example: Momentum Strategy
 *
 * This strategy would track price changes over time and buy/sell based on momentum.
 * This is a skeleton - you would need to implement price history tracking.
 */
export class ExampleMomentumStrategy extends BaseStrategy {
  private priceHistory: Map<string, number[]> = new Map();

  async analyze(): Promise<StrategyResult> {
    const signals: any[] = [];

    // Parameters
    const momentumPeriod = (this.config.parameters.momentumPeriod as number) || 5;
    const momentumThreshold = (this.config.parameters.momentumThreshold as number) || 0.05;

    this.log(`Analyzing momentum over ${momentumPeriod} periods`);

    // In a real implementation:
    // 1. Track prices over time
    // 2. Calculate momentum (price change over period)
    // 3. Generate signals when momentum exceeds threshold

    // Example logic (not functional - just demonstrates the pattern):
    /*
    for (const [tokenId, history] of this.priceHistory) {
      if (history.length >= momentumPeriod) {
        const oldPrice = history[history.length - momentumPeriod];
        const newPrice = history[history.length - 1];
        const momentum = (newPrice - oldPrice) / oldPrice;

        if (momentum > momentumThreshold && !this.hasPosition(tokenId)) {
          // Positive momentum - consider buying
          signals.push(this.createBuySignal(...));
        } else if (momentum < -momentumThreshold && this.hasPosition(tokenId)) {
          // Negative momentum - consider selling
          signals.push(this.createSellSignal(...));
        }
      }
    }
    */

    return { signals };
  }
}

// Note: These strategies are NOT registered by default
// To use them, you would:
// 1. Import in src/strategies/index.ts
// 2. Register: registerStrategy("price-threshold", ExamplePriceThresholdStrategy)
