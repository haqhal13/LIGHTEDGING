/**
 * MarketDiscoveryService - Shared Market Discovery for Polymarket Up/Down Markets
 *
 * Proactively discovers BTC and ETH markets (15-minute and hourly) from Polymarket Gamma API.
 * Used by both priceStreamLogger.ts and paperTradeMonitor (marketdiscovery.ts).
 */

import fetchData from '../utils/fetchData';

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  MARKET_SLUG_PREFIXES: [
    'btc-updown-15m',
    'eth-updown-15m',
    'bitcoin-up-or-down',
    'ethereum-up-or-down',
  ],
  GAMMA_API_URL: 'https://gamma-api.polymarket.com/events',
};

// ============================================================================
// Types
// ============================================================================

export interface MarketToken {
  token_id: string;
  outcome: string;
  winner?: boolean;
}

export interface MarketInfo {
  condition_id: string;
  slug: string;
  question: string;
  end_date_iso: string;
  start_time_iso: string;
  tokens: MarketToken[];
  closed: boolean;
  active: boolean;
  market_type: string;
}

interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  endDate: string;
  startTime: string | null;
  closed: boolean;
  active: boolean;
  markets: GammaMarket[];
}

interface GammaMarket {
  id: string;
  conditionId: string;
  slug: string;
  question: string;
  endDate: string;
  eventStartTime: string | null;
  closed: boolean;
  active: boolean;
  clobTokenIds: string;
  outcomes: string;
}

// ============================================================================
// Logging
// ============================================================================

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [DISCOVERY] [${level.toUpperCase()}]`;
  if (data !== undefined) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

// ============================================================================
// Market Discovery Service
// ============================================================================

export class MarketDiscoveryService {
  private currentMarkets: Map<string, MarketInfo> = new Map();
  private nextMarkets: Map<string, MarketInfo> = new Map();
  private fetchedSlugs: Set<string> = new Set();
  private lastProcessedWindow: number = 0;
  private lastHourProcessed: number = -1;

  /**
   * Fetch all markets from Gamma API
   */
  async fetchAllMarkets(): Promise<MarketInfo[]> {
    try {
      const allMarkets: MarketInfo[] = [];

      // Fetch hourly markets from tag_slug
      const hourlyUrl = `${CONFIG.GAMMA_API_URL}?tag_slug=up-or-down&active=true&closed=false&limit=100&order=endDate&ascending=true`;
      const hourlyMarkets = await this.fetchMarketsFromUrl(hourlyUrl);
      allMarkets.push(...hourlyMarkets);

      // Also fetch hourly markets by slug prefix (backup)
      for (const hourlyPrefix of ['bitcoin-up-or-down', 'ethereum-up-or-down']) {
        const hourlyPrefixUrl = `${CONFIG.GAMMA_API_URL}?slug_contains=${hourlyPrefix}&active=true&closed=false&limit=20`;
        const prefixMarkets = await this.fetchMarketsFromUrl(hourlyPrefixUrl);
        allMarkets.push(...prefixMarkets);
      }

      // Fetch 15m markets using timestamp-based slugs
      const now = Math.floor(Date.now() / 1000);
      for (const prefix of ['btc-updown-15m', 'eth-updown-15m']) {
        for (let offset = -1; offset <= 8; offset++) {
          const targetTime = now + (offset * 900);
          const roundedTime = Math.floor(targetTime / 900) * 900;
          const slug = `${prefix}-${roundedTime}`;
          const marketUrl = `${CONFIG.GAMMA_API_URL}?slug=${slug}`;
          const markets = await this.fetchMarketsFromUrl(marketUrl);
          allMarkets.push(...markets);
        }
      }

      // Deduplicate
      const uniqueMarkets = new Map<string, MarketInfo>();
      for (const market of allMarkets) {
        if (!uniqueMarkets.has(market.condition_id)) {
          uniqueMarkets.set(market.condition_id, market);
        }
      }

      const markets = Array.from(uniqueMarkets.values());
      markets.sort((a, b) => new Date(a.end_date_iso).getTime() - new Date(b.end_date_iso).getTime());

      return markets;
    } catch (error) {
      log('error', 'Failed to fetch markets:', error);
      return [];
    }
  }

  private async fetchMarketsFromUrl(url: string): Promise<MarketInfo[]> {
    try {
      const response = await fetch(url);
      if (!response.ok) return [];

      const events = (await response.json()) as GammaEvent[];
      const markets: MarketInfo[] = [];

      for (const event of events) {
        const marketType = CONFIG.MARKET_SLUG_PREFIXES.find(prefix => event.slug.startsWith(prefix));
        if (!marketType) continue;

        for (const market of event.markets) {
          let tokenIds: string[] = [];
          let outcomeNames: string[] = [];

          try {
            if (market.clobTokenIds) tokenIds = JSON.parse(market.clobTokenIds) as string[];
            if (market.outcomes) outcomeNames = JSON.parse(market.outcomes) as string[];
          } catch {
            continue;
          }

          if (tokenIds.length >= 2) {
            const tokens: MarketToken[] = tokenIds.map((tokenId: string, idx: number) => ({
              token_id: tokenId,
              outcome: outcomeNames[idx] || (idx === 0 ? 'Up' : 'Down'),
            }));

            const startTime = event.startTime || market.eventStartTime || market.endDate;

            markets.push({
              condition_id: market.conditionId,
              slug: market.slug || event.slug,
              question: market.question || event.title,
              end_date_iso: market.endDate || event.endDate,
              start_time_iso: startTime,
              tokens,
              closed: market.closed || event.closed,
              active: market.active && event.active,
              market_type: marketType,
            });
          }
        }
      }

      return markets;
    } catch {
      return [];
    }
  }

  /**
   * Calculate current 15-minute window boundaries in Eastern Time
   */
  private calculateETWindowBoundaries(now: number): {
    currentWindowStartMs: number;
    currentWindowStartSec: number;
    currentETHour: number;
    currentETMinute: number;
    windowStartMinute: number;
  } {
    const etFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const etTimeParts = etFormatter.formatToParts(new Date(now));
    const currentETHour = parseInt(etTimeParts.find(p => p.type === 'hour')?.value || '0', 10);
    const currentETMinute = parseInt(etTimeParts.find(p => p.type === 'minute')?.value || '0', 10);
    const windowStartMinute = Math.floor(currentETMinute / 15) * 15;

    const etDateFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const etDateParts = etDateFormatter.formatToParts(new Date(now));
    const etYear = parseInt(etDateParts.find(p => p.type === 'year')?.value || '2025', 10);
    const etMonth = parseInt(etDateParts.find(p => p.type === 'month')?.value || '1', 10);
    const etDay = parseInt(etDateParts.find(p => p.type === 'day')?.value || '1', 10);

    const windowStartETStr = `${etYear}-${String(etMonth).padStart(2, '0')}-${String(etDay).padStart(2, '0')}T${String(currentETHour).padStart(2, '0')}:${String(windowStartMinute).padStart(2, '0')}:00`;
    const tempWindowDate = new Date(windowStartETStr);
    const etOffset = new Date(tempWindowDate.toLocaleString('en-US', { timeZone: 'America/New_York' })).getTime() -
                     new Date(tempWindowDate.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
    const currentWindowStartMs = tempWindowDate.getTime() - etOffset;
    const currentWindowStartSec = Math.floor(currentWindowStartMs / 1000);

    return { currentWindowStartMs, currentWindowStartSec, currentETHour, currentETMinute, windowStartMinute };
  }

  /**
   * Find current markets for all 4 market types (BTC/ETH 15m and 1h)
   */
  async findCurrentMarketsForAllTypes(): Promise<Map<string, MarketInfo>> {
    const maxRetries = 3;
    const now = Date.now();

    // Calculate ET window boundaries
    const { currentWindowStartSec, currentETHour } = this.calculateETWindowBoundaries(now);

    // Check if window or hour changed - clear cache if so
    const windowChanged = currentWindowStartSec !== Math.floor(this.lastProcessedWindow / 1000);
    const hourChanged = currentETHour !== this.lastHourProcessed;

    if (windowChanged || hourChanged) {
      this.fetchedSlugs.clear();
      this.lastProcessedWindow = currentWindowStartSec * 1000;
      this.lastHourProcessed = currentETHour;
      log('info', `New ${windowChanged ? '15-min window' : 'hour'} detected - clearing cache`);
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const allMarkets = await this.fetchAllMarkets();

      this.currentMarkets.clear();
      this.nextMarkets.clear();

      const marketsByType = new Map<string, MarketInfo[]>();
      for (const market of allMarkets) {
        if (!marketsByType.has(market.market_type)) {
          marketsByType.set(market.market_type, []);
        }
        marketsByType.get(market.market_type)!.push(market);
      }

      for (const marketType of CONFIG.MARKET_SLUG_PREFIXES) {
        const markets = marketsByType.get(marketType) || [];
        let current: MarketInfo | null = null;
        let next: MarketInfo | null = null;

        const nowWithBuffer = now + 1000;

        for (const market of markets) {
          const startTime = new Date(market.start_time_iso).getTime();
          const endTime = new Date(market.end_date_iso).getTime();

          // For 15-min markets, validate this is the CURRENT window
          const is15MinMarket = marketType.includes('updown-15m');
          if (is15MinMarket) {
            const slugTimestampMatch = market.slug.match(/updown-15m-(\d+)/);
            if (slugTimestampMatch) {
              const marketWindowStart = parseInt(slugTimestampMatch[1], 10);
              if (marketWindowStart !== currentWindowStartSec) {
                const isFuture = marketWindowStart > currentWindowStartSec;
                if (isFuture && !next) {
                  next = market;
                }
                continue;
              }
            }
          }

          if (endTime > now) {
            if (startTime <= nowWithBuffer) {
              if (!current) {
                current = market;
              } else {
                const currentStart = new Date(current.start_time_iso).getTime();
                if (startTime > currentStart && startTime <= now) {
                  current = market;
                }
              }
            } else {
              if (current && !next) {
                next = market;
              } else if (!current) {
                current = market;
                const secsUntilStart = Math.round((startTime - now) / 1000);
                log('warn', `[${marketType}] Using FUTURE market as current (starts in ${secsUntilStart}s): ${market.question}`);
              }
            }
          }
        }

        if (current) {
          this.currentMarkets.set(marketType, current);
          const endTime = new Date(current.end_date_iso).getTime();
          const secsLeft = Math.round((endTime - now) / 1000);
          log('info', `[${marketType}] Current: ${current.question} (${secsLeft}s left)`);
        }
        if (next) {
          this.nextMarkets.set(marketType, next);
        }
      }

      if (this.currentMarkets.size >= 4) {
        log('info', `All ${this.currentMarkets.size} markets discovered on attempt ${attempt}`);
        return this.currentMarkets;
      }

      if (attempt < maxRetries) {
        const missing = CONFIG.MARKET_SLUG_PREFIXES.filter(t => !this.currentMarkets.has(t));
        log('warn', `Only ${this.currentMarkets.size}/4 markets found (missing: ${missing.join(', ')}). Retrying...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    log('warn', `Could only find ${this.currentMarkets.size}/4 markets after ${maxRetries} attempts`);
    return this.currentMarkets;
  }

  getCurrentMarkets(): Map<string, MarketInfo> {
    return this.currentMarkets;
  }

  /**
   * Get next markets (discovered in advance for seamless switching)
   */
  getNextMarkets(): Map<string, MarketInfo> {
    return this.nextMarkets;
  }

  /**
   * Get all asset IDs from both current AND next markets
   * This allows subscribing to next market prices in advance
   */
  getAllAssetIds(): string[] {
    const assetIds: string[] = [];

    // Current markets
    Array.from(this.currentMarkets.values()).forEach(market => {
      for (const token of market.tokens) {
        assetIds.push(token.token_id);
      }
    });

    // Next markets (for advance subscription)
    Array.from(this.nextMarkets.values()).forEach(market => {
      for (const token of market.tokens) {
        if (!assetIds.includes(token.token_id)) {
          assetIds.push(token.token_id);
        }
      }
    });

    return assetIds;
  }

  /**
   * Get asset IDs for next markets only
   */
  getNextMarketAssetIds(): string[] {
    const assetIds: string[] = [];
    Array.from(this.nextMarkets.values()).forEach(market => {
      for (const token of market.tokens) {
        assetIds.push(token.token_id);
      }
    });
    return assetIds;
  }

  getMarketByAssetId(assetId: string): MarketInfo | null {
    // Check current markets first
    const currentMarkets = Array.from(this.currentMarkets.values());
    for (const market of currentMarkets) {
      if (market.tokens.some(t => t.token_id === assetId)) {
        return market;
      }
    }

    // Also check next markets (for advance price tracking)
    const nextMarkets = Array.from(this.nextMarkets.values());
    for (const market of nextMarkets) {
      if (market.tokens.some(t => t.token_id === assetId)) {
        return market;
      }
    }

    return null;
  }

  getMarketTypesNeedingSwitch(bufferMs: number = 60000): string[] {
    const now = Date.now();
    const needsSwitch: string[] = [];
    Array.from(this.currentMarkets.entries()).forEach(([marketType, market]) => {
      const endTime = new Date(market.end_date_iso).getTime();
      const timeLeft = endTime - now;
      if (timeLeft < bufferMs || timeLeft < 0) {
        needsSwitch.push(marketType);
      }
    });
    return needsSwitch;
  }

  /**
   * Check if any market has ended or is stale
   * Stale = 15-min market with >16 min left, or 1h market with >61 min left
   */
  hasAnyMarketEnded(): boolean {
    const now = Date.now();
    const markets = Array.from(this.currentMarkets.values());
    for (const market of markets) {
      const endTime = new Date(market.end_date_iso).getTime();
      const timeLeft = endTime - now;

      if (now > endTime) return true;

      const is15Min = market.market_type.includes('15m');
      if (is15Min && timeLeft > 16 * 60 * 1000) {
        log('warn', `[${market.market_type}] Stale market detected (${Math.floor(timeLeft / 60000)}m left for 15m market)`);
        return true;
      }

      const is1Hour = market.market_type.includes('up-or-down');
      if (is1Hour && timeLeft > 61 * 60 * 1000) {
        log('warn', `[${market.market_type}] Stale market detected (${Math.floor(timeLeft / 60000)}m left for 1h market)`);
        return true;
      }
    }
    return false;
  }

  /**
   * Get market key from title (for compatibility with marketTracker)
   */
  static getMarketKey(title: string): string {
    const lowerTitle = title.toLowerCase();

    const isBTC = lowerTitle.includes('bitcoin') || lowerTitle.includes('btc');
    const isETH = lowerTitle.includes('ethereum') || lowerTitle.includes('eth');
    const is15Min = /\d{1,2}:\d{2}\s*(?:[AP]M)?\s*[-–]\s*\d{1,2}:\d{2}/i.test(title);
    const isHourly = (/\d{1,2}\s*(?:am|pm)\s*et/i.test(title) || /\d{1,2}(?:am|pm)-et/i.test(title)) && !is15Min;

    let hourMatch = title.match(/(\d{1,2})\s*(?:am|pm)\s*et/i);
    if (!hourMatch) {
      hourMatch = title.match(/(\d{1,2})(?:am|pm)-et/i);
    }

    if (isBTC) {
      if (is15Min) return 'BTC-UpDown-15';
      if (isHourly && hourMatch) return `BTC-UpDown-1h-${hourMatch[1]}`;
      if (isHourly) return 'BTC-UpDown-1h';
      return 'BTC-UpDown';
    } else if (isETH) {
      if (is15Min) return 'ETH-UpDown-15';
      if (isHourly && hourMatch) return `ETH-UpDown-1h-${hourMatch[1]}`;
      if (isHourly) return 'ETH-UpDown-1h';
      return 'ETH-UpDown';
    }

    return 'Other';
  }
}

// Create singleton instance
export const marketDiscoveryService = new MarketDiscoveryService();

export default marketDiscoveryService;
