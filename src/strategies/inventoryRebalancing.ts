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

      // Analyze this specific market - now returns array of signals (UP and DOWN)
      const marketSignals = await this.analyzeMarket(marketState);

      if (marketSignals && marketSignals.length > 0) {
        signals.push(...marketSignals);
      }
    }

    return { signals };
  }

  /**
   * Analyze a single market and return trade signals for BOTH sides
   * Returns array with UP and DOWN signals for dual-side trading
   */
  private async analyzeMarket(state: MarketState): Promise<TradeSignal[]> {
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
      return [];
    }

    // Update price history for flip detection
    this.updatePriceHistory(state, yesPrice);

    const now = Date.now();

    // Get current inventory for this specific market
    const inventory = this.getMarketInventory(state);
    const totalInventoryValue = inventory.yesValue + inventory.noValue;
    const hasInventory = totalInventoryValue > 0;

    // Check cooldown periods (market-specific)
    const cooldownSec = this.getMarketCooldown(marketType);
    const timeSinceLastRebalance = (now - state.lastRebalanceTime) / 1000;
    if (timeSinceLastRebalance < cooldownSec) {
      return [];
    }

    // Check post-flip cooldown
    if (state.flipDetected && state.flipDetectedTime) {
      const timeSinceFlip = (now - state.flipDetectedTime) / 1000;
      if (timeSinceFlip < this.rebalanceConfig.post_flip_cooldown_sec) {
        return [];
      }
      state.flipDetected = false;
    }

    // CLOSE BEHAVIOR: Skip some trades near market close (15m markets only)
    if (this.shouldSkipTradeNearClose(state)) {
      return [];
    }

    // Calculate YES ratio for inventory tracking
    const yesRatio = hasInventory ? inventory.yesValue / totalInventoryValue : this.rebalanceConfig.target_yes_ratio;

    this.log(`[${this.getShortName(marketType)}] Prices: UP=$${yesPrice.toFixed(4)} DOWN=$${noPrice.toFixed(4)} | Inventory: UP=$${inventory.yesValue.toFixed(2)} DOWN=$${inventory.noValue.toFixed(2)} | Ratio: ${(yesRatio * 100).toFixed(1)}%`);

    // Check if we have enough balance
    if (this.balance <= this.rebalanceConfig.min_trade_size) {
      return [];
    }

    const targetRatio = this.rebalanceConfig.target_yes_ratio;

    // CLOSE BEHAVIOR: Get size multiplier for near-close trades (15m markets only)
    const closeSizeMultiplier = this.getCloseSizeMultiplier(state);

    // DUAL-SIDE TRADING: Generate signals for BOTH UP and DOWN every cycle
    // This builds balanced inventory for recovery when prices flip
    const signals = this.calculateDualSideSignals(
      state,
      inventory,
      yesPrice,
      noPrice,
      yesRatio,
      targetRatio,
      closeSizeMultiplier
    );

    if (signals.length > 0) {
      state.lastRebalanceTime = now;
      state.lastPrice = yesPrice;
      state.lastPriceTime = now;

      if (this.rebalanceConfig.log_every_trade) {
        for (const signal of signals) {
          this.log(
            `[${this.getShortName(marketType)}] Signal: ${signal.side} ${signal.size.toFixed(2)} @ $${signal.price.toFixed(4)} (${(signal.metadata as any)?.outcome})`
          );
        }
      }
    }

    return signals;
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

    // Debug: Log which markets priceStreamLogger has (only once per missing market)
    if (this.marketStates.size < 4) {
      const foundTypes = Array.from(streamMarkets.keys());
      const missingTypes = InventoryBalancedRebalancingStrategy.MARKET_TYPES.filter(t => !streamMarkets.has(t));
      if (missingTypes.length > 0) {
        this.log(`[DEBUG] priceStreamLogger has ${streamMarkets.size} markets: [${foundTypes.join(', ')}]`);
        this.log(`[DEBUG] Missing market types: [${missingTypes.join(', ')}]`);
      }
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

  /**
   * RATIO-WEIGHTED DUAL-SIDE TRADING: Trade both sides weighted by inventory needs
   * Trade sizing formula: $0.75 + (price × 10), clamped to $0.01-$26.00
   *
   * Strategy:
   * - Calculate base trade size for each side using the formula
   * - Weight trades based on how far inventory is from target ratio
   * - Side with less inventory gets traded more aggressively
   * - Can skip a side if it's already overweight (above target ratio)
   * - STOP trading the losing side when winning side price > 0.90
   */
  private calculateDualSideSignals(
    state: MarketState,
    inventory: { yesSize: number; noSize: number; yesValue: number; noValue: number },
    yesPrice: number,
    noPrice: number,
    currentYesRatio: number,
    targetRatio: number,
    closeSizeMultiplier: number = 1.0
  ): TradeSignal[] {
    const { market, yesTokenId, noTokenId, marketType } = state;
    const signals: TradeSignal[] = [];

    // Check if we have enough balance
    if (this.balance < this.rebalanceConfig.min_trade_size) {
      return signals;
    }

    // Price stop threshold used for tilt progress calculation
    const priceStopThreshold = this.rebalanceConfig.price_stop_threshold;

    // Calculate base trade sizes using formula: base + (price × multiplier)
    // Apply close size multiplier for near-close behavior (15m markets)
    const baseUpAmount = this.calculateTradeSize(yesPrice, marketType) * closeSizeMultiplier;
    const baseDownAmount = this.calculateTradeSize(noPrice, marketType) * closeSizeMultiplier;

    // TILT BOOST: When one side >= tilt_threshold, boost trades on winning side
    // WATCHER STYLE: Never stop one side completely, just favor the cheaper side
    const tiltThreshold = this.rebalanceConfig.tilt_threshold;
    const tiltBoost = this.rebalanceConfig.tilt_boost_multiplier;

    let upBoost = 1.0;
    let downBoost = 1.0;

    // WATCHER BEHAVIOR: Always trade BOTH sides, but favor cheaper side (55/45 split)
    // When price < 0.46: favor buying that side
    // When price > 0.54: favor buying opposite (cheaper) side
    // Never stop one side completely

    if (yesPrice >= tiltThreshold) {
      upBoost = tiltBoost;  // Boost UP trades when UP is winning
      // Reduce DOWN but NEVER to zero - minimum 0.15x (watcher never stops a side)
      const tiltProgress = Math.min(1, (yesPrice - tiltThreshold) / (priceStopThreshold - tiltThreshold));
      downBoost = Math.max(0.15, 0.5 * (1 - tiltProgress));  // 0.5 → 0.15 as price goes 0.59 → 0.90+
    }
    if (noPrice >= tiltThreshold) {
      downBoost = tiltBoost;  // Boost DOWN trades when DOWN is winning
      // Reduce UP but NEVER to zero - minimum 0.15x
      const tiltProgress = Math.min(1, (noPrice - tiltThreshold) / (priceStopThreshold - tiltThreshold));
      upBoost = Math.max(0.15, 0.5 * (1 - tiltProgress));  // 0.5 → 0.15 as price goes 0.59 → 0.90+
    }

    // Apply boost to base amounts
    const boostedUpAmount = baseUpAmount * upBoost;
    const boostedDownAmount = baseDownAmount * downBoost;

    const totalInventory = inventory.yesValue + inventory.noValue;

    // Calculate how much each side deviates from target
    // If target is 0.5 (50/50), and current YES is 0.7 (70%), YES is +0.2 overweight
    // Negative means underweight (needs more), positive means overweight (skip or reduce)
    let yesDeviation = 0;
    let noDeviation = 0;

    if (totalInventory > 0) {
      yesDeviation = currentYesRatio - targetRatio;  // Positive = overweight
      noDeviation = (1 - currentYesRatio) - (1 - targetRatio);  // Positive = overweight
    }

    // Calculate weight multipliers based on deviation
    // Underweight side gets full weight (1.0), overweight gets reduced (can be 0)
    // Weight = 1 - (deviation / max_skew_ratio), clamped 0-1
    const maxSkew = this.rebalanceConfig.max_skew_ratio;

    // YES weight: if underweight (negative deviation), weight = 1.0
    // If overweight, reduce weight proportionally
    let yesWeight = Math.max(0, Math.min(1, 1 - (yesDeviation / maxSkew)));
    let noWeight = Math.max(0, Math.min(1, 1 - (noDeviation / maxSkew)));

    // WATCHER BEHAVIOR: Never stop one side completely
    // Just apply the tilt boost/reduction from above
    // The 0.15x minimum ensures we always trade both sides

    // Apply weights to BOOSTED trade amounts
    const upTradeAmount = boostedUpAmount * yesWeight;
    const downTradeAmount = boostedDownAmount * noWeight;

    let remainingBalance = this.balance;

    // Generate UP (YES) signal if weighted amount is sufficient
    if (upTradeAmount >= this.rebalanceConfig.min_trade_size && remainingBalance >= upTradeAmount) {
      const tradeSize = upTradeAmount / yesPrice;
      if (tradeSize >= 0.01) {
        const tradePrice = this.calculateOrderPrice(yesPrice, "BUY");
        signals.push(this.createBuySignal(market, yesTokenId, tradePrice, Math.floor(tradeSize * 100) / 100, {
          rebalance: true,
          dualSideTrade: true,
          weight: yesWeight,
          tiltBoost: upBoost,
          currentYesRatio,
          targetRatio,
          outcome: "Up",
          marketType,
        }));
        remainingBalance -= upTradeAmount;
      }
    }

    // Generate DOWN (NO) signal if weighted amount is sufficient
    if (downTradeAmount >= this.rebalanceConfig.min_trade_size && remainingBalance >= downTradeAmount) {
      const tradeSize = downTradeAmount / noPrice;
      if (tradeSize >= 0.01) {
        const tradePrice = this.calculateOrderPrice(noPrice, "BUY");
        signals.push(this.createBuySignal(market, noTokenId, tradePrice, Math.floor(tradeSize * 100) / 100, {
          rebalance: true,
          dualSideTrade: true,
          weight: noWeight,
          tiltBoost: downBoost,
          currentYesRatio,
          targetRatio,
          outcome: "Down",
          marketType,
        }));
      }
    }

    // If no trades due to weighting, but we have balance and one side is very underweight
    // Force a trade on the underweight side to maintain some inventory balance (with tilt boost)
    if (signals.length === 0 && this.balance >= this.rebalanceConfig.min_trade_size) {
      const buyYes = inventory.yesValue <= inventory.noValue;

      if (buyYes && boostedUpAmount >= this.rebalanceConfig.min_trade_size && this.balance >= boostedUpAmount) {
        const tradeSize = boostedUpAmount / yesPrice;
        if (tradeSize >= 0.01) {
          const tradePrice = this.calculateOrderPrice(yesPrice, "BUY");
          signals.push(this.createBuySignal(market, yesTokenId, tradePrice, Math.floor(tradeSize * 100) / 100, {
            rebalance: true,
            fallbackTrade: true,
            tiltBoost: upBoost,
            currentYesRatio,
            targetRatio,
            outcome: "Up",
            marketType,
          }));
        }
      } else if (!buyYes && boostedDownAmount >= this.rebalanceConfig.min_trade_size && this.balance >= boostedDownAmount) {
        const tradeSize = boostedDownAmount / noPrice;
        if (tradeSize >= 0.01) {
          const tradePrice = this.calculateOrderPrice(noPrice, "BUY");
          signals.push(this.createBuySignal(market, noTokenId, tradePrice, Math.floor(tradeSize * 100) / 100, {
            rebalance: true,
            fallbackTrade: true,
            tiltBoost: downBoost,
            currentYesRatio,
            targetRatio,
            outcome: "Down",
            marketType,
          }));
        }
      }
    }

    return signals;
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

  /**
   * Calculate trade size based on market type
   * 1-Hour: $0.50 + (price × 8), clamped $0.01-$14.00
   * 15-Min: $0.25 + (price × 12), clamped $0.01-$26.00
   *
   * BELL CURVE: If enabled, applies a multiplier that peaks at 0.50 and
   * decreases towards extremes (0.10 and 0.90)
   * Formula: multiplier = extreme + (peak - extreme) × (1 - |price - 0.5| × 2)
   */
  private calculateTradeSize(price: number, marketType: string): number {
    const config = this.rebalanceConfig;
    const is15m = this.is15MinuteMarket(marketType);

    let baseSize: number;
    if (is15m) {
      // 15-Minute: aggressive sizing
      baseSize = config.sizing_15m_base + (price * config.sizing_15m_multiplier);
      baseSize = Math.max(config.sizing_15m_min_trade, Math.min(baseSize, config.sizing_15m_max_trade));
    } else {
      // 1-Hour: conservative sizing
      baseSize = config.sizing_1h_base + (price * config.sizing_1h_multiplier);
      baseSize = Math.max(config.sizing_1h_min_trade, Math.min(baseSize, config.sizing_1h_max_trade));
    }

    // Apply bell curve if enabled
    // Peak at 0.50, minimum at extremes (0.10, 0.90)
    if (config.bell_curve_enabled) {
      const distanceFromCenter = Math.abs(price - 0.5);
      // Linear interpolation: at center (distance=0) → peak, at edge (distance=0.5) → extreme
      // multiplier = extreme + (peak - extreme) × (1 - distance × 2)
      const curveMultiplier = config.bell_curve_extreme_multiplier +
        (config.bell_curve_peak_multiplier - config.bell_curve_extreme_multiplier) *
        Math.max(0, 1 - distanceFromCenter * 2);
      baseSize *= curveMultiplier;
    }

    return baseSize;
  }

  /**
   * Get cooldown seconds based on market type
   * 1-Hour: 6 seconds
   * 15-Min: 2 seconds
   */
  private getMarketCooldown(marketType: string): number {
    const config = this.rebalanceConfig;
    return this.is15MinuteMarket(marketType)
      ? config.sizing_15m_cooldown_sec
      : config.sizing_1h_cooldown_sec;
  }

  /**
   * Check if market type is 15-minute
   */
  private is15MinuteMarket(marketType: string): boolean {
    return marketType.includes('15m') || marketType.includes('updown-15');
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

  /**
   * Get minutes and seconds until market close
   * Returns { minutesLeft, secondsLeft } or null if no end date
   */
  private getTimeUntilClose(state: MarketState): { minutesLeft: number; secondsLeft: number } | null {
    const endDate = state.market.endDate;
    if (!endDate) {
      return null;
    }

    const now = Date.now();
    const endTime = new Date(endDate).getTime();
    const msLeft = endTime - now;

    if (msLeft <= 0) {
      return { minutesLeft: 0, secondsLeft: 0 };
    }

    const secondsLeft = msLeft / 1000;
    const minutesLeft = secondsLeft / 60;

    return { minutesLeft, secondsLeft };
  }

  /**
   * Check if trade should be skipped due to close behavior (frequency reduction)
   * Returns true if trade should be skipped
   */
  private shouldSkipTradeNearClose(state: MarketState): boolean {
    // Only apply to 15-minute markets
    if (!this.is15MinuteMarket(state.marketType)) {
      return false;
    }

    const timeLeft = this.getTimeUntilClose(state);
    if (!timeLeft) {
      return false;
    }

    const config = this.rebalanceConfig;

    // Check if we should stop trading completely
    if (config.close_stop_trading_seconds > 0 && timeLeft.secondsLeft <= config.close_stop_trading_seconds) {
      return true;
    }

    // Check if we're in reduced activity zone
    if (timeLeft.minutesLeft <= config.close_reduce_activity_minutes) {
      // Only execute a percentage of trades (randomly skip)
      return Math.random() > config.close_activity_multiplier;
    }

    return false;
  }

  /**
   * Get trade size multiplier based on time until close
   * Returns multiplier (e.g., 0.60 for 60% of normal size)
   */
  private getCloseSizeMultiplier(state: MarketState): number {
    // Only apply to 15-minute markets
    if (!this.is15MinuteMarket(state.marketType)) {
      return 1.0;
    }

    const timeLeft = this.getTimeUntilClose(state);
    if (!timeLeft) {
      return 1.0;
    }

    const config = this.rebalanceConfig;

    // Check if we're in reduced size zone
    if (timeLeft.minutesLeft <= config.close_reduce_size_minutes) {
      return config.close_size_multiplier;
    }

    return 1.0;
  }
}
