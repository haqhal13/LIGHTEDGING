import { ObjectId } from "mongoose";

// Market data interfaces
export interface Market {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string[];
  outcomePrices: string[];
  volume: string;
  liquidity: string;
  endDate: string;
  active: boolean;
}

export interface OrderBookEntry {
  price: string;
  size: string;
}

export interface OrderBook {
  market: string;
  asset_id: string;
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  timestamp: string;
}

// Position interfaces
export interface Position {
  conditionId: string;
  tokenId: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentPrice?: number;
  currentValue?: number;
  cashPnl?: number;
  percentPnl?: number;
  realizedPnl?: number;
  timestamp: Date;
}

// Trade/Order interfaces
export type TradeSide = "BUY" | "SELL";
export type OrderType = "GTC" | "FOK" | "GTD";

export interface TradeSignal {
  marketId: string;
  conditionId: string;
  tokenId: string;
  side: TradeSide;
  price: number;
  size: number;
  strategyName: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface TradeExecution {
  id: string;
  signal: TradeSignal;
  executedPrice: number;
  executedSize: number;
  fees: number;
  status: "pending" | "filled" | "partial" | "cancelled" | "failed";
  paperTrade: boolean;
  timestamp: Date;
  transactionHash?: string;
  error?: string;
}

export interface TradeHistory {
  marketId: string;
  conditionId: string;
  tokenId: string;
  side: TradeSide;
  price: number;
  size: number;
  usdcSize: number;
  fees: number;
  strategyName: string;
  paperTrade: boolean;
  timestamp: Date;
  transactionHash?: string;
}

// Paper trading interfaces
export interface PaperAccount {
  balance: number;
  positions: Map<string, Position>;
  tradeHistory: TradeHistory[];
  startingBalance: number;
  createdAt: Date;
}

// Strategy interface - implement this to create your own strategies
export interface StrategyConfig {
  name: string;
  enabled: boolean;
  parameters: Record<string, unknown>;
}

export interface StrategyResult {
  signals: TradeSignal[];
  metadata?: Record<string, unknown>;
}

// Event interfaces for the bot
export interface BotEvent {
  type: "signal" | "execution" | "error" | "info";
  timestamp: Date;
  data: unknown;
}

// Polymarket API response types
export interface UserActivity {
  proxyWallet: string;
  side: TradeSide;
  size: string;
  price: string;
  timestamp: number;
  transactionHash: string;
  conditionId: string;
  asset: string;
  type: string;
  usdcSize: string;
  feeRateBps: string;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  pseudonym: string;
  profileImage: string;
  bot?: boolean;
  botExecutedTime?: number;
}

export interface UserPosition {
  proxyWallet: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  realizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcomeIndex: number;
  tokenId: string;
  oppositeTokenId: string;
  endDate: string;
  neg_risk: boolean;
}
