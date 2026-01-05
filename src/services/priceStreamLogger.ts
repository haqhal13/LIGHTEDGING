/**
 * Price Stream Logger - WebSocket-based Real-time Price Streaming
 *
 * Streams BTC/ETH Up/Down market prices from Polymarket's CLOB WebSocket.
 * Automatically switches to the next market when the current one ends.
 * Integrates with existing bot infrastructure for trade logging.
 *
 * Based on: https://github.com/haqhal13/CVSMODULE
 */

import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { getRunId } from '../utils/runId';
import { MarketDiscoveryService, MarketInfo, MarketToken } from './MarketDiscoveryService';

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // Market discovery settings - multiple market types to track
  MARKET_SLUG_PREFIXES: [
    'btc-updown-15m',           // BTC 15-minute
    'eth-updown-15m',           // ETH 15-minute
    'bitcoin-up-or-down',       // BTC hourly
    'ethereum-up-or-down',      // ETH hourly
  ],
  GAMMA_API_URL: 'https://gamma-api.polymarket.com/events',
  CLOB_API_URL: 'https://clob.polymarket.com',

  // Timing
  MARKET_CHECK_INTERVAL_MS: parseInt(process.env.MARKET_CHECK_INTERVAL_MS || '30000', 10),
  MARKET_SWITCH_BUFFER_MS: parseInt(process.env.MARKET_SWITCH_BUFFER_MS || '60000', 10),
  FLUSH_EVERY_MS: parseInt(process.env.FLUSH_EVERY_MS || '5000', 10), // Flush every 5s for more frequent writes

  // WebSocket
  WS_URL: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  PING_INTERVAL_MS: 5000,
  RECONNECT_BACKOFF_MS: parseInt(process.env.RECONNECT_BACKOFF_MS || '1000', 10),
  MAX_RECONNECT_BACKOFF_MS: 60000,

  // Logging
  LOG_LEVEL: (process.env.PRICE_LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',
};

// ============================================================================
// Types
// ============================================================================

interface OrderBookLevel {
  price: string;
  size: string;
}

interface BookEvent {
  event_type: 'book';
  asset_id: string;
  market: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: string;
}

interface PriceChangeItem {
  asset_id: string;
  price: string;
  size: string;
  side: 'BUY' | 'SELL';
  best_bid?: string;
  best_ask?: string;
}

interface PriceChangeEvent {
  event_type: 'price_change';
  market: string;
  price_changes: PriceChangeItem[];
  timestamp: string;
}

interface LastTradePriceEvent {
  event_type: 'last_trade_price';
  asset_id: string;
  market: string;
  price: string;
  side: 'BUY' | 'SELL';
  size: string;
  timestamp: string;
}

interface BestBidAskEvent {
  event_type: 'best_bid_ask';
  market: string;
  asset_id: string;
  best_bid: string;
  best_ask: string;
  timestamp: string;
}

type MarketEvent = BookEvent | PriceChangeEvent | LastTradePriceEvent | BestBidAskEvent;

interface AssetState {
  lastPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  lastTradePrice: number | null;
  marketConditionId: string | null;
}

// MarketToken and MarketInfo are imported from MarketDiscoveryService

// CSV Row format matching your existing structure
interface CSVRow {
  timestamp: number;
  date: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  priceUp: number;
  priceDown: number;
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
  entryType: string;  // 'WATCH', 'PAPER', or '' for price-only rows
  watchEntry: string;
  paperEntry: string;
  notes: string;
}

// ============================================================================
// Logging
// ============================================================================

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
  if (LOG_LEVELS[level] >= LOG_LEVELS[CONFIG.LOG_LEVEL]) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [PRICE] [${level.toUpperCase()}]`;
    if (data !== undefined) {
      console.log(`${prefix} ${message}`, data);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }
}

function getTimestampBreakdown(timestamp: number): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
} {
  const date = new Date(timestamp);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    millisecond: date.getUTCMilliseconds(),
  };
}

function normalizeTimestamp(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

// ============================================================================
// Market Discovery - Now using shared MarketDiscoveryService
// ============================================================================
// MarketDiscoveryService is imported from ./MarketDiscoveryService

// ============================================================================
// CSV Writer - Compatible with existing format
// ============================================================================

class CSVWriter {
  private buffer: CSVRow[] = [];
  private writeStream: fs.WriteStream;
  private flushInterval: NodeJS.Timeout | null = null;
  private headerWritten = false;
  private recentRowKeys: Set<string> = new Set();
  private lastWrittenTimestamp: number = 0;
  private static DEDUP_WINDOW_SIZE = 100;

  constructor(private filePath: string, private flushEveryMs: number) {
    const dir = path.dirname(filePath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.headerWritten = fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
    this.writeStream = fs.createWriteStream(filePath, { flags: 'a' });

    if (!this.headerWritten) {
      this.writeHeader();
    }

    this.startFlushInterval();
    log('info', `CSV writer initialized: ${filePath}`);
  }

  private writeHeader(): void {
    const header = [
      'Timestamp',
      'Date',
      'Year',
      'Month',
      'Day',
      'Hour',
      'Minute',
      'Second',
      'Millisecond',
      'Price UP ($)',
      'Price DOWN ($)',
      'UP Bid',
      'UP Ask',
      'DOWN Bid',
      'DOWN Ask',
      'Entry Type',       // WATCH, PAPER, or empty for price-only
      'Watch Mode Entry',
      'Paper Mode Entry',
      'Notes'
    ].join(',') + '\n';
    this.writeStream.write(header);
    this.headerWritten = true;
  }

  private startFlushInterval(): void {
    if (this.flushEveryMs <= 0) return;
    this.flushInterval = setInterval(() => {
      this.flush();
    }, this.flushEveryMs);
  }

  addRow(row: CSVRow): boolean {
    const rowKey = `${row.timestamp}|${row.priceUp.toFixed(4)}|${row.priceDown.toFixed(4)}`;
    const isTradeEntry = row.watchEntry === 'YES' || row.paperEntry === 'YES';

    // For trade entries, use a different dedup key that includes the notes
    const dedupeKey = isTradeEntry
      ? `${row.timestamp}|${row.notes}`
      : rowKey;

    if (this.recentRowKeys.has(dedupeKey)) {
      return false;
    }

    // Only apply timestamp ordering check to price rows, not trade entries
    // Trade entries may come in slightly after their actual timestamp
    if (!isTradeEntry && row.timestamp < this.lastWrittenTimestamp - 1000) {
      return false;
    }

    // Validate price consistency
    const total = row.priceUp + row.priceDown;
    if (row.priceUp > 0 && row.priceDown > 0 && Math.abs(total - 1.0) > 0.05) {
      return false;
    }

    this.recentRowKeys.add(dedupeKey);
    if (this.recentRowKeys.size > CSVWriter.DEDUP_WINDOW_SIZE) {
      const keysArray = Array.from(this.recentRowKeys);
      this.recentRowKeys = new Set(keysArray.slice(keysArray.length / 2));
    }

    // Only update lastWrittenTimestamp for price rows, not trade entries
    // This prevents trade entries from blocking future price rows
    if (!isTradeEntry) {
      this.lastWrittenTimestamp = row.timestamp;
    }

    this.buffer.push(row);
    return true;
  }

  flush(): void {
    if (this.buffer.length === 0) return;

    const rows = this.buffer.splice(0, this.buffer.length);

    const csvLines = rows.map(row => {
      const tb = getTimestampBreakdown(row.timestamp);
      const values = [
        row.timestamp,
        row.date,
        tb.year,
        tb.month,
        tb.day,
        tb.hour,
        tb.minute,
        tb.second,
        tb.millisecond,
        row.priceUp.toFixed(4),
        row.priceDown.toFixed(4),
        row.upBid !== null ? row.upBid.toFixed(4) : '',
        row.upAsk !== null ? row.upAsk.toFixed(4) : '',
        row.downBid !== null ? row.downBid.toFixed(4) : '',
        row.downAsk !== null ? row.downAsk.toFixed(4) : '',
        row.entryType || '',  // WATCH, PAPER, or empty
        row.watchEntry,
        row.paperEntry,
        row.notes ? `"${row.notes.replace(/"/g, '""')}"` : '',
      ];
      return values.join(',');
    }).join('\n') + '\n';

    this.writeStream.write(csvLines);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.flushInterval) {
        clearInterval(this.flushInterval);
      }
      this.flush();
      this.writeStream.end(() => {
        resolve();
      });
    });
  }
}

// ============================================================================
// Price Calculator
// ============================================================================

function safeParseNumber(value: string | undefined | null): number | null {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return isNaN(num) ? null : num;
}

function computeMidPrice(bestBid: number | null, bestAsk: number | null): number | null {
  if (bestBid !== null && bestAsk !== null && bestBid > 0 && bestAsk > 0) {
    return (bestBid + bestAsk) / 2;
  }
  return null;
}

function getBestFromBook(levels: OrderBookLevel[], isBid: boolean): number | null {
  if (!levels || levels.length === 0) return null;

  const validLevels = levels.filter(l => {
    const size = safeParseNumber(l.size);
    return size !== null && size > 0;
  });

  if (validLevels.length === 0) return null;

  const sorted = validLevels.sort((a, b) => {
    const priceA = safeParseNumber(a.price) || 0;
    const priceB = safeParseNumber(b.price) || 0;
    return isBid ? priceB - priceA : priceA - priceB;
  });

  return safeParseNumber(sorted[0].price);
}

// ============================================================================
// Pending Price Data
// ============================================================================

interface PendingPrice {
  price: number;
  bid: number | null;
  ask: number | null;
  assetId: string;
  ts_ms: number;
}

interface PendingRow {
  marketType: string;
  up: PendingPrice | null;
  down: PendingPrice | null;
  lastUpdate: number;
}

// ============================================================================
// Price Stream Logger - Main Class
// ============================================================================

class PriceStreamLogger {
  private ws: WebSocket | null = null;
  private assetStates: Map<string, AssetState> = new Map();
  private writers: Map<string, CSVWriter> = new Map();
  private marketDiscovery: MarketDiscoveryService;
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private marketCheckInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private isConnected = false;
  private isStarted = false;
  private currentAssetIds: string[] = [];
  private pendingRows: Map<string, PendingRow> = new Map();

  // For trade entry marking
  private loggedTradeEntries: Set<string> = new Set();

  // Price history for lookups
  private priceHistory: Map<string, Array<{ timestamp: number; priceUp: number; priceDown: number }>> = new Map();
  private maxPriceHistorySize = 600;

  constructor() {
    this.marketDiscovery = new MarketDiscoveryService();

    const logsDir = path.join(process.cwd(), 'logs');
    const livePricesDir = path.join(logsDir, 'Live prices');

    if (!fs.existsSync(livePricesDir)) {
      fs.mkdirSync(livePricesDir, { recursive: true });
    }

    const runId = getRunId();

    // Initialize CSV writers for each market type with your existing naming convention
    const marketFiles: Record<string, string> = {
      'btc-updown-15m': `BTC - 15 min prices_${runId}.csv`,
      'eth-updown-15m': `ETH - 15 min prices_${runId}.csv`,
      'bitcoin-up-or-down': `BTC - 1 hour prices_${runId}.csv`,
      'ethereum-up-or-down': `ETH - 1 hour prices_${runId}.csv`,
    };

    for (const [marketType, filename] of Object.entries(marketFiles)) {
      const filePath = path.join(livePricesDir, filename);
      this.writers.set(marketType, new CSVWriter(filePath, CONFIG.FLUSH_EVERY_MS));
    }

    log('info', `Price Stream Logger initialized with ${this.writers.size} CSV files`);
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      log('warn', 'Price stream already started');
      return;
    }

    this.isStarted = true;
    log('info', 'Starting WebSocket price stream...');

    await this.discoverAndConnect();
    this.startMarketCheckInterval();
  }

  async stop(): Promise<void> {
    log('info', 'Stopping price stream...');
    this.isShuttingDown = true;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.stopPingInterval();
    this.stopMarketCheckInterval();

    if (this.ws) {
      this.ws.close(1000, 'Shutdown');
    }

    const closePromises: Promise<void>[] = [];
    Array.from(this.writers.values()).forEach(writer => {
      closePromises.push(writer.close());
    });
    await Promise.all(closePromises);

    this.isStarted = false;
    log('info', 'Price stream stopped');
  }

  private async discoverAndConnect(): Promise<void> {
    log('info', 'Discovering Up/Down markets...');

    const currentMarkets = await this.marketDiscovery.findCurrentMarketsForAllTypes();

    if (currentMarkets.size === 0) {
      log('warn', 'No active markets found. Will retry in 30 seconds...');
      return;
    }

    const assetIds = this.marketDiscovery.getAllAssetIds();

    if (assetIds.length === 0) {
      log('error', 'No asset IDs found');
      return;
    }

    if (this.arraysEqual(assetIds, this.currentAssetIds)) {
      return;
    }

    // Track which assets are new vs unchanged
    const oldAssetSet = new Set(this.currentAssetIds);
    const newAssetSet = new Set(assetIds);
    const unchangedAssets = assetIds.filter(id => oldAssetSet.has(id));
    const addedAssets = assetIds.filter(id => !oldAssetSet.has(id));
    const removedAssets = this.currentAssetIds.filter(id => !newAssetSet.has(id));

    log('info', `Market assets changed: ${addedAssets.length} added, ${removedAssets.length} removed, ${unchangedAssets.length} unchanged`);

    this.currentAssetIds = assetIds;
    this.initializeAssetStates(assetIds);

    // If WebSocket is open and healthy, just re-subscribe instead of reconnecting
    // This avoids the gap where prices are unavailable during reconnection
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.isConnected) {
      log('info', 'WebSocket open - re-subscribing to updated assets without reconnect');
      this.subscribe();
      return;
    }

    // Otherwise, close and reconnect
    if (this.ws) {
      this.ws.close(1000, 'Market switch');
    }

    this.connect();
  }

  private initializeAssetStates(assetIds: string[]): void {
    // IMPORTANT: Don't clear all states - preserve existing states for unchanged assets
    // This prevents price gaps during 15-min market rotations affecting 1-hour markets

    const newAssetSet = new Set(assetIds);
    const existingAssetIds = new Set(this.assetStates.keys());

    // Remove states for assets no longer tracked
    for (const existingId of existingAssetIds) {
      if (!newAssetSet.has(existingId)) {
        this.assetStates.delete(existingId);
      }
    }

    // Add states for new assets (preserve existing ones)
    for (const assetId of assetIds) {
      if (!this.assetStates.has(assetId)) {
        this.assetStates.set(assetId, {
          lastPrice: null,
          bestBid: null,
          bestAsk: null,
          lastTradePrice: null,
          marketConditionId: null,
        });
      }
    }

    log('info', `Asset states updated: ${this.assetStates.size} assets (${assetIds.length - existingAssetIds.size} new, ${existingAssetIds.size - (existingAssetIds.size - this.assetStates.size)} preserved)`);
  }

  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((val, idx) => val === sortedB[idx]);
  }

  private startMarketCheckInterval(): void {
    this.stopMarketCheckInterval();

    // Track last refresh time to force periodic refresh
    let lastForceRefresh = Date.now();
    const FORCE_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // Force refresh every 5 minutes

    this.marketCheckInterval = setInterval(async () => {
      if (this.isShuttingDown) return;

      const now = Date.now();
      const needsSwitch = this.marketDiscovery.getMarketTypesNeedingSwitch();
      const anyEnded = this.marketDiscovery.hasAnyMarketEnded();
      const timeSinceRefresh = now - lastForceRefresh;

      // Refresh if:
      // 1. Any market needs switching (< 60s left)
      // 2. Any market has ended
      // 3. It's been more than 5 minutes since last refresh (force periodic refresh)
      if (needsSwitch.length > 0 || anyEnded || timeSinceRefresh > FORCE_REFRESH_INTERVAL_MS) {
        if (timeSinceRefresh > FORCE_REFRESH_INTERVAL_MS) {
          log('info', 'Periodic market refresh (every 5 min)...');
        }
        lastForceRefresh = now;
        await this.discoverAndConnect();
      }
    }, CONFIG.MARKET_CHECK_INTERVAL_MS);
  }

  private stopMarketCheckInterval(): void {
    if (this.marketCheckInterval) {
      clearInterval(this.marketCheckInterval);
      this.marketCheckInterval = null;
    }
  }

  private connect(): void {
    if (this.isShuttingDown) return;
    if (this.currentAssetIds.length === 0) return;

    log('info', `Connecting to WebSocket...`);

    this.ws = new WebSocket(CONFIG.WS_URL);

    this.ws.on('open', () => this.onOpen());
    this.ws.on('message', (data: WebSocket.RawData) => this.onMessage(data));
    this.ws.on('error', (error: Error) => this.onError(error));
    this.ws.on('close', (code: number, reason: Buffer) => this.onClose(code, reason));
    this.ws.on('pong', () => log('debug', 'Received pong'));
  }

  private onOpen(): void {
    log('info', 'WebSocket connected');
    this.isConnected = true;
    this.reconnectAttempts = 0;

    this.subscribe();
    this.startPingInterval();
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const subscribeMsg = {
      assets_ids: this.currentAssetIds,
      type: 'market',
    };

    log('info', `Subscribing to ${this.currentAssetIds.length} assets`);
    this.ws.send(JSON.stringify(subscribeMsg));
  }

  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, CONFIG.PING_INTERVAL_MS);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private onMessage(data: WebSocket.RawData): void {
    try {
      const message = JSON.parse(data.toString());
      const events: MarketEvent[] = Array.isArray(message) ? message : [message];

      for (const event of events) {
        this.processEvent(event);
      }
    } catch (error) {
      log('error', 'Failed to parse message:', error);
    }
  }

  private processEvent(event: MarketEvent): void {
    if (!event.event_type) return;

    switch (event.event_type) {
      case 'book':
        this.handleBookEvent(event);
        break;
      case 'price_change':
        this.handlePriceChangeEvent(event);
        break;
      case 'last_trade_price':
        this.handleLastTradePriceEvent(event);
        break;
      case 'best_bid_ask':
        this.handleBestBidAskEvent(event);
        break;
    }
  }

  private handleBookEvent(event: BookEvent): void {
    const { asset_id, market, bids, asks, timestamp } = event;
    if (!this.assetStates.has(asset_id)) return;

    const state = this.assetStates.get(asset_id)!;
    const bestBid = getBestFromBook(bids, true);
    const bestAsk = getBestFromBook(asks, false);

    state.bestBid = bestBid;
    state.bestAsk = bestAsk;
    state.marketConditionId = market;

    const midPrice = computeMidPrice(bestBid, bestAsk);
    const price = midPrice ?? state.lastTradePrice;

    if (price !== null) {
      this.maybeWriteRow(asset_id, price, bestBid, bestAsk, timestamp);
    }
  }

  private handlePriceChangeEvent(event: PriceChangeEvent): void {
    const { market, price_changes, timestamp } = event;

    for (const change of price_changes) {
      const { asset_id, best_bid, best_ask } = change;
      if (!this.assetStates.has(asset_id)) continue;

      const state = this.assetStates.get(asset_id)!;
      state.marketConditionId = market;

      if (best_bid !== undefined) state.bestBid = safeParseNumber(best_bid);
      if (best_ask !== undefined) state.bestAsk = safeParseNumber(best_ask);

      const midPrice = computeMidPrice(state.bestBid, state.bestAsk);
      const price = midPrice ?? state.lastTradePrice;

      if (price !== null) {
        this.maybeWriteRow(asset_id, price, state.bestBid, state.bestAsk, timestamp);
      }
    }
  }

  private handleLastTradePriceEvent(event: LastTradePriceEvent): void {
    const { asset_id, market, price: priceStr, timestamp } = event;
    if (!this.assetStates.has(asset_id)) return;

    const state = this.assetStates.get(asset_id)!;
    const tradePrice = safeParseNumber(priceStr);

    if (tradePrice === null) return;

    state.lastTradePrice = tradePrice;
    state.marketConditionId = market;

    const midPrice = computeMidPrice(state.bestBid, state.bestAsk);
    const price = midPrice ?? tradePrice;

    this.maybeWriteRow(asset_id, price, state.bestBid, state.bestAsk, timestamp);
  }

  private handleBestBidAskEvent(event: BestBidAskEvent): void {
    const { asset_id, market, best_bid, best_ask, timestamp } = event;
    if (!this.assetStates.has(asset_id)) return;

    const state = this.assetStates.get(asset_id)!;
    state.bestBid = safeParseNumber(best_bid);
    state.bestAsk = safeParseNumber(best_ask);
    state.marketConditionId = market;

    const midPrice = computeMidPrice(state.bestBid, state.bestAsk);
    const price = midPrice ?? state.lastTradePrice;

    if (price !== null) {
      this.maybeWriteRow(asset_id, price, state.bestBid, state.bestAsk, timestamp);
    }
  }

  private maybeWriteRow(
    assetId: string,
    price: number,
    bestBid: number | null,
    bestAsk: number | null,
    timestampStr: string
  ): void {
    const state = this.assetStates.get(assetId)!;

    const roundedPrice = Math.round(price * 1e6) / 1e6;
    const roundedLastPrice = state.lastPrice !== null ? Math.round(state.lastPrice * 1e6) / 1e6 : null;

    if (roundedPrice === roundedLastPrice) return;

    state.lastPrice = roundedPrice;

    const tsMs = safeParseNumber(timestampStr) ?? Date.now();

    const market = this.marketDiscovery.getMarketByAssetId(assetId);
    const token = market?.tokens.find((t: MarketToken) => t.token_id === assetId);
    const outcomeLabel = token?.outcome || 'Unknown';
    const marketType = market?.market_type || 'Unknown';

    const pendingPrice: PendingPrice = {
      price: roundedPrice,
      bid: bestBid,
      ask: bestAsk,
      assetId: assetId,
      ts_ms: tsMs,
    };

    let pending = this.pendingRows.get(marketType);
    if (!pending) {
      pending = { marketType, up: null, down: null, lastUpdate: tsMs };
      this.pendingRows.set(marketType, pending);
    }

    // Clear stale data
    const STALE_THRESHOLD_MS = 5000;
    if (pending.up && (tsMs - pending.up.ts_ms) > STALE_THRESHOLD_MS) pending.up = null;
    if (pending.down && (tsMs - pending.down.ts_ms) > STALE_THRESHOLD_MS) pending.down = null;

    const isUp = outcomeLabel.toUpperCase() === 'UP';
    if (isUp) {
      pending.up = pendingPrice;
    } else {
      pending.down = pendingPrice;
    }
    pending.lastUpdate = tsMs;

    // Combine UP and DOWN into single row
    if (pending.up && pending.down) {
      const timeDiff = Math.abs(pending.up.ts_ms - pending.down.ts_ms);

      if (timeDiff <= 2000) {
        this.writeCombinedRow(marketType, pending);
        pending.up = null;
        pending.down = null;
      } else {
        if (pending.up.ts_ms < pending.down.ts_ms) {
          pending.up = null;
        } else {
          pending.down = null;
        }
      }
    }
  }

  private writeCombinedRow(marketType: string, pending: PendingRow): void {
    const writer = this.writers.get(marketType);
    if (!writer) return;

    const tsMs = pending.lastUpdate;
    const priceUp = pending.up?.price || 0;
    const priceDown = pending.down?.price || 0;

    const row: CSVRow = {
      timestamp: tsMs,
      date: new Date(tsMs).toISOString(),
      year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0, millisecond: 0,
      priceUp,
      priceDown,
      upBid: pending.up?.bid || null,
      upAsk: pending.up?.ask || null,
      downBid: pending.down?.bid || null,
      downAsk: pending.down?.ask || null,
      entryType: '',  // Price-only row
      watchEntry: '',
      paperEntry: '',
      notes: '',
    };

    if (writer.addRow(row)) {
      // Store in price history for trade lookups
      const historyKey = this.getHistoryKey(marketType);
      let history = this.priceHistory.get(historyKey);
      if (!history) {
        history = [];
        this.priceHistory.set(historyKey, history);
      }
      history.push({ timestamp: tsMs, priceUp, priceDown });
      if (history.length > this.maxPriceHistorySize) {
        history.shift();
      }
    }
  }

  private getHistoryKey(marketType: string): string {
    if (marketType.includes('btc') || marketType.includes('bitcoin')) {
      return marketType.includes('15m') ? 'BTC-15m' : 'BTC-1h';
    }
    return marketType.includes('15m') ? 'ETH-15m' : 'ETH-1h';
  }

  private onError(error: Error): void {
    log('error', 'WebSocket error:', error.message);
  }

  private onClose(code: number, reason: Buffer): void {
    log('warn', `WebSocket closed: code=${code}`);
    this.isConnected = false;
    this.stopPingInterval();

    if (!this.isShuttingDown) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    const backoff = Math.min(
      CONFIG.RECONNECT_BACKOFF_MS * Math.pow(2, this.reconnectAttempts),
      CONFIG.MAX_RECONNECT_BACKOFF_MS
    );

    log('info', `Reconnecting in ${backoff}ms...`);

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectAttempts++;
      await this.discoverAndConnect();
    }, backoff);
  }

  // ============================================================================
  // Public API - Compatible with existing interface
  // ============================================================================

  /**
   * Log price update - now handled automatically by WebSocket
   * Kept for backward compatibility but does nothing
   */
  logPrice(_marketSlug: string, _marketTitle: string, _priceUp: number, _priceDown: number): void {
    // Prices are now streamed via WebSocket - this is a no-op for compatibility
  }

  /**
   * Notify that a new market window has started
   * Now handled automatically by market discovery
   */
  notifyNewMarketWindow(_type: 'BTC' | 'ETH', _timeframe: '15m' | '1h', _windowStartTimestamp: number): void {
    // Market windows are now tracked automatically
  }

  /**
   * Check if logging is enabled for a market
   */
  isLoggingEnabled(_type: 'BTC' | 'ETH', _timeframe: '15m' | '1h'): boolean {
    return this.isConnected;
  }

  /**
   * Get current active markets discovered by the WebSocket
   */
  getCurrentMarkets(): Map<string, MarketInfo> {
    return this.marketDiscovery.getCurrentMarkets();
  }

  /**
   * Get mid price for a given token/asset ID from the WebSocket stream
   * Returns null if no price data available
   */
  getMidPrice(tokenId: string): number | null {
    const state = this.assetStates.get(tokenId);
    if (!state) {
      return null;
    }

    // Calculate mid price from best bid/ask if available
    if (state.bestBid !== null && state.bestAsk !== null && state.bestBid > 0 && state.bestAsk > 0) {
      return (state.bestBid + state.bestAsk) / 2;
    }

    // Fall back to last price or last trade price
    return state.lastPrice ?? state.lastTradePrice ?? null;
  }

  /**
   * Get all current asset states (for debugging)
   */
  getAssetStates(): Map<string, AssetState> {
    return this.assetStates;
  }

  /**
   * Mark a watcher trade entry in the CSV
   */
  markWatchEntry(
    marketSlug: string,
    marketTitle: string,
    priceUp: number,
    priceDown: number,
    notes?: string,
    transactionHash?: string,
    tradeTimestamp?: number
  ): void {
    const marketType = this.getMarketTypeFromSlug(marketSlug, marketTitle);
    if (!marketType) return;

    const writer = this.writers.get(marketType);
    if (!writer) return;

    const tradeKey = transactionHash ? `WATCH:${transactionHash}` : `WATCH:${marketType}:${notes}`;
    if (this.loggedTradeEntries.has(tradeKey)) return;
    this.loggedTradeEntries.add(tradeKey);

    const timestamp = tradeTimestamp || Date.now();

    // Look up prices from history if available
    const historyKey = this.getHistoryKey(marketType);
    const prices = this.findPriceAtTimestamp(historyKey, timestamp);
    const finalPriceUp = prices?.priceUp || priceUp;
    const finalPriceDown = prices?.priceDown || priceDown;

    const row: CSVRow = {
      timestamp,
      date: new Date(timestamp).toISOString(),
      year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0, millisecond: 0,
      priceUp: finalPriceUp,
      priceDown: finalPriceDown,
      upBid: null,
      upAsk: null,
      downBid: null,
      downAsk: null,
      entryType: 'WATCH',
      watchEntry: 'YES',
      paperEntry: '',
      notes: `WATCH: ${notes || ''}`,
    };

    writer.addRow(row);
    log('info', `Logged WATCH entry: ${notes}`);
  }

  /**
   * Mark a paper trade entry in the CSV
   */
  markPaperEntry(
    marketSlug: string,
    marketTitle: string,
    priceUp: number,
    priceDown: number,
    notes?: string,
    transactionHash?: string,
    tradeTimestamp?: number
  ): void {
    const marketType = this.getMarketTypeFromSlug(marketSlug, marketTitle);
    if (!marketType) return;

    const writer = this.writers.get(marketType);
    if (!writer) return;

    const tradeKey = transactionHash ? `PAPER:${transactionHash}` : `PAPER:${marketType}:${notes}`;
    if (this.loggedTradeEntries.has(tradeKey)) return;
    this.loggedTradeEntries.add(tradeKey);

    const timestamp = tradeTimestamp || Date.now();

    // Look up prices from history if available
    const historyKey = this.getHistoryKey(marketType);
    const prices = this.findPriceAtTimestamp(historyKey, timestamp);
    const finalPriceUp = prices?.priceUp || priceUp;
    const finalPriceDown = prices?.priceDown || priceDown;

    const row: CSVRow = {
      timestamp,
      date: new Date(timestamp).toISOString(),
      year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0, millisecond: 0,
      priceUp: finalPriceUp,
      priceDown: finalPriceDown,
      upBid: null,
      upAsk: null,
      downBid: null,
      downAsk: null,
      entryType: 'PAPER',
      watchEntry: '',
      paperEntry: 'YES',
      notes: `PAPER: ${notes || ''}`,
    };

    writer.addRow(row);
    log('info', `Logged PAPER entry: ${notes}`);
  }

  /**
   * Get current prices (for compatibility)
   */
  getCurrentPrices(_marketSlug: string, _marketTitle: string): { priceUp: number; priceDown: number } | null {
    return null;
  }

  private getMarketTypeFromSlug(slug: string, title: string): string | null {
    const searchText = `${slug} ${title}`.toLowerCase();

    const isBTC = searchText.includes('bitcoin') || searchText.includes('btc');
    const isETH = searchText.includes('ethereum') || searchText.includes('eth');

    if (!isBTC && !isETH) return null;

    const is15Min = /\b15\s*min|\b15min|updown.*?15|15.*?updown/i.test(searchText) ||
                    /\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:am|pm)/i.test(searchText);

    if (isBTC) {
      return is15Min ? 'btc-updown-15m' : 'bitcoin-up-or-down';
    } else {
      return is15Min ? 'eth-updown-15m' : 'ethereum-up-or-down';
    }
  }

  private findPriceAtTimestamp(historyKey: string, targetTimestamp: number): { priceUp: number; priceDown: number } | null {
    const history = this.priceHistory.get(historyKey);
    if (!history || history.length === 0) return null;

    let closest = history[0];
    let closestDiff = Math.abs(closest.timestamp - targetTimestamp);

    for (const point of history) {
      const diff = Math.abs(point.timestamp - targetTimestamp);
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = point;
      }
    }

    // Only return historical price if it's within 30 seconds of the target timestamp
    // This prevents using stale prices from old markets when market switches occur
    const MAX_STALE_MS = 30000;
    if (closestDiff <= MAX_STALE_MS) {
      return { priceUp: closest.priceUp, priceDown: closest.priceDown };
    }

    // Return null to let caller use passed-in prices instead of stale historical data
    return null;
  }
}

// Create singleton instance
const priceStreamLogger = new PriceStreamLogger();

// Auto-start when imported (will run in background)
priceStreamLogger.start().catch(err => {
  console.error('Failed to start price stream:', err);
});

export default priceStreamLogger;
