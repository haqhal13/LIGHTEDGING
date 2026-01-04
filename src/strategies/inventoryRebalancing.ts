import { BaseStrategy } from "./baseStrategy";
import { StrategyResult, Market, Position, TradeSignal } from "../interfaces";
import { getRebalanceConfig, RebalanceConfig } from "../config/rebalanceConfig";
import { MarketDataService } from "../services/marketData";
import priceStreamLogger from "../services/priceStreamLogger";

interface PriceHistory {
  price: number;
  timestamp: number;
}

interface MarketState {
  lastRebalanceTime: number;
  lastPrice: number | null;
  lastPriceTime: number | null;
  flipDetected: boolean;
  flipDetectedTime: number | null;
  lastTradePrices: Array<{ price: number; timestamp: number }>;
  // Market identifiers
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  marketType: string; // e.g., 'btc-updown-15m'
  market: Market;
}

/**
 * Inventory-Balanced Rebalancing (Market-Maker Style) Strategy
 *
 * NOW TRADES ON ALL 4 MARKETS:
 * - BTC 15-minute (btc-updown-15m)
 * - ETH 15-minute (eth-updown-15m)
 * - BTC 1-hour (bitcoin-up-or-down)
 * - ETH 1-hour (ethereum-up-or-down)
 *
 * Goal: Keep YES/NO inventory near a target split, and only "lean" toward one side
 * when price moves — so you can recover quickly if it flips.
 */
export class InventoryBalancedRebalancingStrategy extends BaseStrategy {
  // State per market (keyed by marketType)
  private marketStates: Map<string, MarketState> = new Map();

  // Market types to trade on
  private static readonly MARKET_TYPES = [
    'btc-updown-15m',
    'eth-updown-15m',
    'bitcoin-up-or-down',
    'ethereum-up-or-down'
  ];

  constructor(config: any, marketData: MarketDataService) {
    super(config, marketData);
  }

  /**
   * Get current config (always fresh - supports hot-reload)
   */
  private get rebalanceConfig(): RebalanceConfig {
    return getRebalanceConfig();
  }

  async onBeforeAnalysis(): Promise<void> {
    // Initialize/update all markets from priceStreamLogger
    await this.initializeAllMarkets();
  }

  async analyze(): Promise<StrategyResult> {
    const signals: TradeSignal[] = [];

    // Analyze each market independently
    for (const marketType of InventoryBalancedRebalancingStrategy.MARKET_TYPES) {
      const marketState = this.marketStates.get(marketType);

      if (!marketState) {
        continue; // Market not yet discovered
      }

      // Analyze this specific market
      const signal = await this.analyzeMarket(marketState);

      if (signal) {
        signals.push(signal);
      }
    }

    return { signals };
  }

  /**
   * Analyze a single market and return a trade signal if needed
   */
  private async analyzeMarket(state: MarketState): Promise<TradeSignal | null> {
    const { marketType, market } = state;
    let { yesTokenId, noTokenId } = state;

    // Check if market window has changed by comparing token IDs
    const currentMarkets = priceStreamLogger.getCurrentMarkets();
    const wsMarket = currentMarkets.get(marketType);

    if (wsMarket) {
      const upToken = wsMarket.tokens.find((t: any) =>
        t.outcome?.toLowerCase() === 'up' || t.outcome?.toLowerCase() === 'yes'
      );
      const downToken = wsMarket.tokens.find((t: any) =>
        t.outcome?.toLowerCase() === 'down' || t.outcome?.toLowerCase() === 'no'
      );

      // If token ID changed, update market state and use new token IDs
      if (upToken && upToken.token_id !== yesTokenId) {
        this.log(`[${this.getShortName(marketType)}] Market window changed - updating...`);
        this.updateMarketState(marketType, wsMarket);
        // Use the NEW token IDs for price lookup
        yesTokenId = upToken.token_id;
        noTokenId = downToken?.token_id || noTokenId;
      }
    }

    // Get current prices from priceStreamLogger (WebSocket stream)
    const yesPrice = priceStreamLogger.getMidPrice(yesTokenId);
    const noPrice = priceStreamLogger.getMidPrice(noTokenId);

    // If WebSocket prices not available, skip this market
    if (yesPrice === null || noPrice === null) {
      return null;
    }

    // Update price history for flip detection
    this.updatePriceHistory(state, yesPrice);

    const now = Date.now();

    // Get current inventory for this specific market
    const inventory = this.getMarketInventory(state);
    const totalInventoryValue = inventory.yesValue + inventory.noValue;
    const hasInventory = totalInventoryValue > 0;

    // Check if we have unbalanced initial inventory
    const inventoryOnlyYes = inventory.yesValue > 0 && inventory.noValue === 0;
    const inventoryOnlyNo = inventory.noValue > 0 && inventory.yesValue === 0;
    const isUnbalancedInitial = inventoryOnlyYes || inventoryOnlyNo;

    // Check cooldown periods (but bypass for initial/balancing trades)
    const timeSinceLastRebalance = (now - state.lastRebalanceTime) / 1000;
    if (!isUnbalancedInitial && timeSinceLastRebalance < this.rebalanceConfig.min_seconds_between_rebalances) {
      return null;
    }

    // Check post-flip cooldown (but bypass for initial/balancing trades)
    if (!isUnbalancedInitial && state.flipDetected && state.flipDetectedTime) {
      const timeSinceFlip = (now - state.flipDetectedTime) / 1000;
      if (timeSinceFlip < this.rebalanceConfig.post_flip_cooldown_sec) {
        return null;
      }
      state.flipDetected = false;
    }

    // Calculate YES ratio for inventory tracking
    const yesRatio = hasInventory ? inventory.yesValue / totalInventoryValue : this.rebalanceConfig.target_yes_ratio;

    this.log(`[${this.getShortName(marketType)}] Prices: UP=$${yesPrice.toFixed(4)} DOWN=$${noPrice.toFixed(4)} | Inventory: UP=$${inventory.yesValue.toFixed(2)} DOWN=$${inventory.noValue.toFixed(2)} | Ratio: ${(yesRatio * 100).toFixed(1)}%`);

    // Check if rebalancing is needed
    const targetRatio = this.rebalanceConfig.target_yes_ratio;

    const needsInitialTrade = !hasInventory && this.balance > this.rebalanceConfig.min_trade_size;
    const needsBalancingTrade = isUnbalancedInitial && this.balance > this.rebalanceConfig.min_trade_size;

    // CONTINUOUS TRADING: Always trade when cooldown passed and we have balance
    // This ensures we trade on every cycle (respecting min_seconds_between_rebalances)
    const canContinuouslyTrade = this.balance > this.rebalanceConfig.min_trade_size;

    // Always allow trading if we have balance and cooldown passed
    const needsRebalance = needsInitialTrade || needsBalancingTrade || canContinuouslyTrade;

    if (!needsRebalance) {
      return null;
    }

    // For continuous dual-side trading, we always allow trades
    // The strategy naturally balances by buying whichever side has less inventory
    // Risk controls are handled by the sizing formula and bankroll limits

    // Calculate rebalance signal
    const rebalanceSignal = this.calculateRebalanceSignal(
      state,
      inventory,
      yesPrice,
      noPrice,
      yesRatio,
      targetRatio
    );

    if (rebalanceSignal) {
      state.lastRebalanceTime = now;
      state.lastPrice = yesPrice;
      state.lastPriceTime = now;

      if (this.rebalanceConfig.log_every_trade) {
        this.log(
          `[${this.getShortName(marketType)}] Signal: ${rebalanceSignal.side} ${rebalanceSignal.size.toFixed(2)} @ $${rebalanceSignal.price.toFixed(4)}`
        );
      }
    }

    return rebalanceSignal;
  }

  /**
   * Initialize all markets from priceStreamLogger
   */
  private async initializeAllMarkets(): Promise<void> {
    const streamMarkets = priceStreamLogger.getCurrentMarkets();

    if (streamMarkets.size === 0) {
      // Wait a bit for priceStreamLogger to discover markets
      if (this.marketStates.size === 0) {
        this.log("Waiting for priceStreamLogger to discover markets...");
      }
      return;
    }

    for (const marketType of InventoryBalancedRebalancingStrategy.MARKET_TYPES) {
      const wsMarket = streamMarkets.get(marketType);

      if (!wsMarket) {
        continue; // Market not available yet
      }

      const existingState = this.marketStates.get(marketType);

      // Check if we need to initialize or update
      if (!existingState) {
        this.initializeMarketState(marketType, wsMarket);
      } else {
        // Check if token IDs changed (market window switched)
        const upToken = wsMarket.tokens.find((t: any) =>
          t.outcome?.toLowerCase() === 'up' || t.outcome?.toLowerCase() === 'yes'
        );

        if (upToken && upToken.token_id !== existingState.yesTokenId) {
          this.updateMarketState(marketType, wsMarket);
        }
      }
    }
  }

  /**
   * Initialize state for a new market
   */
  private initializeMarketState(marketType: string, wsMarket: any): void {
    const upToken = wsMarket.tokens.find((t: any) =>
      t.outcome?.toLowerCase() === 'up' || t.outcome?.toLowerCase() === 'yes'
    );
    const downToken = wsMarket.tokens.find((t: any) =>
      t.outcome?.toLowerCase() === 'down' || t.outcome?.toLowerCase() === 'no'
    );

    if (!upToken || !downToken) {
      return;
    }

    const market: Market = {
      conditionId: wsMarket.condition_id,
      question: wsMarket.question || 'Unknown Market',
      outcomes: ['Up', 'Down'],
      active: true,
      endDate: wsMarket.end_date_iso,
    } as Market;

    const state: MarketState = {
      lastRebalanceTime: 0,
      lastPrice: null,
      lastPriceTime: null,
      flipDetected: false,
      flipDetectedTime: null,
      lastTradePrices: [],
      conditionId: wsMarket.condition_id,
      yesTokenId: upToken.token_id,
      noTokenId: downToken.token_id,
      marketType,
      market,
    };

    this.marketStates.set(marketType, state);
    this.log(`[${this.getShortName(marketType)}] Initialized: ${wsMarket.question}`);
  }

  /**
   * Update state when market window changes
   */
  private updateMarketState(marketType: string, wsMarket: any): void {
    const upToken = wsMarket.tokens.find((t: any) =>
      t.outcome?.toLowerCase() === 'up' || t.outcome?.toLowerCase() === 'yes'
    );
    const downToken = wsMarket.tokens.find((t: any) =>
      t.outcome?.toLowerCase() === 'down' || t.outcome?.toLowerCase() === 'no'
    );

    if (!upToken || !downToken) {
      return;
    }

    const existingState = this.marketStates.get(marketType);

    const market: Market = {
      conditionId: wsMarket.condition_id,
      question: wsMarket.question || 'Unknown Market',
      outcomes: ['Up', 'Down'],
      active: true,
      endDate: wsMarket.end_date_iso,
    } as Market;

    const state: MarketState = {
      // Reset timing state for new market window
      lastRebalanceTime: 0,
      lastPrice: null,
      lastPriceTime: null,
      flipDetected: false,
      flipDetectedTime: null,
      lastTradePrices: [],
      // Update market identifiers
      conditionId: wsMarket.condition_id,
      yesTokenId: upToken.token_id,
      noTokenId: downToken.token_id,
      marketType,
      market,
    };

    this.marketStates.set(marketType, state);
    this.log(`[${this.getShortName(marketType)}] Updated to new window: ${wsMarket.question}`);
  }

  /**
   * Get inventory for a specific market
   */
  private getMarketInventory(state: MarketState): {
    yesSize: number;
    noSize: number;
    yesValue: number;
    noValue: number;
  } {
    const yesPosition = this.positions.find((p) => p.tokenId === state.yesTokenId);
    const noPosition = this.positions.find((p) => p.tokenId === state.noTokenId);

    const yesSize = yesPosition?.size || 0;
    const noSize = noPosition?.size || 0;

    const yesPrice = yesPosition?.currentPrice || yesPosition?.avgPrice || 0;
    const noPrice = noPosition?.currentPrice || noPosition?.avgPrice || 0;

    const yesValue = yesSize * yesPrice;
    const noValue = noSize * noPrice;

    return { yesSize, noSize, yesValue, noValue };
  }

  private updatePriceHistory(state: MarketState, currentPrice: number): void {
    const now = Date.now();
    state.lastTradePrices.push({ price: currentPrice, timestamp: now });

    const windowMs = this.rebalanceConfig.flip_detection_window_sec * 1000;
    state.lastTradePrices = state.lastTradePrices.filter(
      (p) => now - p.timestamp <= windowMs
    );

    if (state.lastTradePrices.length >= 2 && state.lastPrice !== null) {
      const oldPrice = state.lastTradePrices[0].price;
      const priceChange = (currentPrice - oldPrice) / oldPrice;

      if (Math.abs(priceChange) > this.rebalanceConfig.price_move_threshold * 2) {
        const previousDirection = currentPrice > state.lastPrice ? 1 : -1;
        const currentDirection = currentPrice > oldPrice ? 1 : -1;

        if (previousDirection !== currentDirection) {
          state.flipDetected = true;
          state.flipDetectedTime = now;
        }
      }
    }
  }

  private checkPriceMoveThreshold(state: MarketState, currentPrice: number): boolean {
    if (state.lastPrice === null) {
      return true;
    }

    const priceChange = Math.abs((currentPrice - state.lastPrice) / state.lastPrice);
    return priceChange >= this.rebalanceConfig.price_move_threshold;
  }

  private canTrade(currentYesRatio: number): boolean {
    const targetRatio = this.rebalanceConfig.target_yes_ratio;

    const yesNoRatio = currentYesRatio / (1 - currentYesRatio + 0.0001);
    const noYesRatio = (1 - currentYesRatio) / (currentYesRatio + 0.0001);

    if (
      yesNoRatio > this.rebalanceConfig.max_inventory_imbalance_ratio ||
      noYesRatio > this.rebalanceConfig.max_inventory_imbalance_ratio
    ) {
      if (this.rebalanceConfig.reduce_only_mode) {
        return true;
      }
      const stopAddThreshold = this.rebalanceConfig.stop_add_threshold;
      const imbalanceRatio = Math.max(yesNoRatio, noYesRatio);
      const thresholdRatio = this.rebalanceConfig.max_inventory_imbalance_ratio * stopAddThreshold;

      if (imbalanceRatio > thresholdRatio) {
        return false;
      }
    }

    return true;
  }

  private calculateRebalanceSignal(
    state: MarketState,
    inventory: { yesSize: number; noSize: number; yesValue: number; noValue: number },
    yesPrice: number,
    noPrice: number,
    currentYesRatio: number,
    targetRatio: number
  ): TradeSignal | null {
    const { market, yesTokenId, noTokenId, marketType } = state;

    // Calculate per-market bankroll (divide total by 4 markets)
    const perMarketBankroll = this.rebalanceConfig.bankroll_total / 4;
    const totalValue = inventory.yesValue + inventory.noValue + this.balance;
    const availableBankroll = Math.min(totalValue, perMarketBankroll);

    const targetYesValue = availableBankroll * targetRatio;
    const targetNoValue = availableBankroll * (1 - targetRatio);

    const yesDeviation = inventory.yesValue - targetYesValue;
    const noDeviation = inventory.noValue - targetNoValue;

    // Handle initial trade case - use price-based sizing: $1 + (price × $11)
    const hasNoInventory = inventory.yesValue === 0 && inventory.noValue === 0;
    if (hasNoInventory && this.balance > 0) {
      const shouldBuyYes = state.lastTradePrices.length % 2 === 0;

      if (shouldBuyYes) {
        const buyAmount = this.calculateTradeSize(yesPrice);
        if (buyAmount >= this.rebalanceConfig.min_trade_size && this.balance >= buyAmount) {
          const tradeSize = buyAmount / yesPrice;
          const tradePrice = this.calculateOrderPrice(yesPrice, "BUY");
          return this.createBuySignal(market, yesTokenId, tradePrice, Math.floor(tradeSize * 100) / 100, {
            rebalance: true,
            initialTrade: true,
            currentYesRatio,
            targetRatio,
            outcome: "Up",
            marketType,
          });
        }
      } else {
        const buyAmount = this.calculateTradeSize(noPrice);
        if (buyAmount >= this.rebalanceConfig.min_trade_size && this.balance >= buyAmount) {
          const tradeSize = buyAmount / noPrice;
          const tradePrice = this.calculateOrderPrice(noPrice, "BUY");
          return this.createBuySignal(market, noTokenId, tradePrice, Math.floor(tradeSize * 100) / 100, {
            rebalance: true,
            initialTrade: true,
            currentYesRatio,
            targetRatio,
            outcome: "Down",
            marketType,
          });
        }
      }
    }

    // Handle unbalanced initial inventory - use price-based sizing
    const hasOnlyYes = inventory.yesValue > 0 && inventory.noValue === 0;
    const hasOnlyNo = inventory.noValue > 0 && inventory.yesValue === 0;

    if (hasOnlyYes && this.balance > 0) {
      const buyAmount = this.calculateTradeSize(noPrice);
      if (buyAmount >= this.rebalanceConfig.min_trade_size && this.balance >= buyAmount) {
        const tradeSize = buyAmount / noPrice;
        const tradePrice = this.calculateOrderPrice(noPrice, "BUY");
        return this.createBuySignal(market, noTokenId, tradePrice, Math.floor(tradeSize * 100) / 100, {
          rebalance: true,
          balancingTrade: true,
          currentYesRatio,
          targetRatio,
          outcome: "Down",
          marketType,
        });
      }
    }

    if (hasOnlyNo && this.balance > 0) {
      const buyAmount = this.calculateTradeSize(yesPrice);
      if (buyAmount >= this.rebalanceConfig.min_trade_size && this.balance >= buyAmount) {
        const tradeSize = buyAmount / yesPrice;
        const tradePrice = this.calculateOrderPrice(yesPrice, "BUY");
        return this.createBuySignal(market, yesTokenId, tradePrice, Math.floor(tradeSize * 100) / 100, {
          rebalance: true,
          balancingTrade: true,
          currentYesRatio,
          targetRatio,
          outcome: "Up",
          marketType,
        });
      }
    }

    // Determine which side to trade
    let tradeSide: "BUY" | "SELL" | null = null;
    let tradeTokenId: string | null = null;
    let tradePrice: number = 0;
    let tradeSize: number = 0;

    const strength = state.flipDetected
      ? this.rebalanceConfig.rebalance_strength_k * this.rebalanceConfig.flip_response_multiplier
      : this.rebalanceConfig.rebalance_strength_k;

    // DUAL-SIDE TRADING: Buy the WINNING side (higher price = more likely to win)
    // This ensures we're always accumulating on the side that's currently favored
    if (this.balance > 0) {
      // Buy the side with the HIGHER price - that's the winning/favored side
      const buyYes = yesPrice >= noPrice;

      if (buyYes) {
        // Buy UP (YES) - use UP price for sizing
        const tradeAmount = this.calculateTradeSize(yesPrice);
        if (tradeAmount >= this.rebalanceConfig.min_trade_size && this.balance >= tradeAmount) {
          tradeSize = tradeAmount / yesPrice;
          tradeSide = "BUY";
          tradeTokenId = yesTokenId;
          tradePrice = this.calculateOrderPrice(yesPrice, "BUY");

          if (tradeSize >= 0.01) {
            tradeSize = Math.floor(tradeSize * 100) / 100;
            return this.createBuySignal(market, tradeTokenId, tradePrice, tradeSize, {
              rebalance: true,
              continuousTrade: true,
              currentYesRatio,
              targetRatio,
              outcome: "Up",
              marketType,
            });
          }
        }
      } else {
        // Buy DOWN (NO) - use DOWN price for sizing
        const tradeAmount = this.calculateTradeSize(noPrice);
        if (tradeAmount >= this.rebalanceConfig.min_trade_size && this.balance >= tradeAmount) {
          tradeSize = tradeAmount / noPrice;
          tradeSide = "BUY";
          tradeTokenId = noTokenId;
          tradePrice = this.calculateOrderPrice(noPrice, "BUY");

          if (tradeSize >= 0.01) {
            tradeSize = Math.floor(tradeSize * 100) / 100;
            return this.createBuySignal(market, tradeTokenId, tradePrice, tradeSize, {
              rebalance: true,
              continuousTrade: true,
              currentYesRatio,
              targetRatio,
              outcome: "Down",
              marketType,
            });
          }
        }
      }
    }

    // Determine which side needs rebalancing more
    if (Math.abs(yesDeviation) > Math.abs(noDeviation)) {
      const rebalanceAmount = this.calculateTradeSize(yesPrice);
      tradeSize = rebalanceAmount / yesPrice;

      if (rebalanceAmount < this.rebalanceConfig.min_trade_size) {
        return null;
      }

      if (yesDeviation > 0) {
        tradeSide = "SELL";
        tradeTokenId = yesTokenId;
        tradePrice = this.calculateOrderPrice(yesPrice, "SELL");
        if (inventory.yesSize < tradeSize) {
          tradeSize = inventory.yesSize;
        }
      } else {
        tradeSide = "BUY";
        tradeTokenId = yesTokenId;
        tradePrice = this.calculateOrderPrice(yesPrice, "BUY");
      }
    } else {
      const rebalanceAmount = this.calculateTradeSize(noPrice);
      tradeSize = rebalanceAmount / noPrice;

      if (rebalanceAmount < this.rebalanceConfig.min_trade_size) {
        return null;
      }

      if (noDeviation > 0) {
        tradeSide = "SELL";
        tradeTokenId = noTokenId;
        tradePrice = this.calculateOrderPrice(noPrice, "SELL");
        if (inventory.noSize < tradeSize) {
          tradeSize = inventory.noSize;
        }
      } else {
        tradeSide = "BUY";
        tradeTokenId = noTokenId;
        tradePrice = this.calculateOrderPrice(noPrice, "BUY");
      }
    }

    if (!tradeSide || !tradeTokenId || tradeSize < 0.01) {
      return null;
    }

    // Apply reduce-only mode if needed
    if (this.rebalanceConfig.reduce_only_mode) {
      const yesNoRatio = inventory.yesValue / (inventory.noValue + 0.0001);
      const noYesRatio = inventory.noValue / (inventory.yesValue + 0.0001);
      const maxRatio = this.rebalanceConfig.max_inventory_imbalance_ratio;

      if (yesNoRatio > maxRatio) {
        if (tradeTokenId === yesTokenId && tradeSide === "BUY") return null;
        if (tradeTokenId === noTokenId && tradeSide === "SELL") return null;
      } else if (noYesRatio > maxRatio) {
        if (tradeTokenId === noTokenId && tradeSide === "BUY") return null;
        if (tradeTokenId === yesTokenId && tradeSide === "SELL") return null;
      }
    }

    tradeSize = Math.floor(tradeSize * 100) / 100;
    const outcome = tradeTokenId === yesTokenId ? "Up" : "Down";

    if (tradeSide === "BUY") {
      return this.createBuySignal(market, tradeTokenId, tradePrice, tradeSize, {
        rebalance: true,
        currentYesRatio,
        targetRatio,
        outcome,
        marketType,
      });
    } else {
      return this.createSellSignal(market, tradeTokenId, tradePrice, tradeSize, {
        rebalance: true,
        currentYesRatio,
        targetRatio,
        outcome,
        marketType,
      });
    }
  }

  private calculateOrderPrice(midPrice: number, side: "BUY" | "SELL"): number {
    if (this.rebalanceConfig.order_type === "market") {
      return midPrice;
    }

    const offset = this.rebalanceConfig.limit_price_offset;
    if (side === "BUY") {
      return midPrice * (1 - offset);
    } else {
      return midPrice * (1 + offset);
    }
  }

  private calculateTradeSize(price: number): number {
    const config = this.rebalanceConfig;

    if (config.use_price_based_sizing) {
      const dynamicSize = config.sizing_base + (price * config.sizing_price_multiplier);
      return Math.max(config.min_trade_size, Math.min(dynamicSize, config.max_trade_size));
    }

    return config.max_trade_size;
  }

  /**
   * Get short display name for a market type
   */
  private getShortName(marketType: string): string {
    switch (marketType) {
      case 'btc-updown-15m': return 'BTC-15m';
      case 'eth-updown-15m': return 'ETH-15m';
      case 'bitcoin-up-or-down': return 'BTC-1h';
      case 'ethereum-up-or-down': return 'ETH-1h';
      default: return marketType;
    }
  }
}
