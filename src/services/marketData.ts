import { ClobClient } from "@polymarket/clob-client";
import { fetchData } from "../utils/fetchData";
import { Market, OrderBook, UserPosition } from "../interfaces";
import logger from "../utils/logger";

const GAMMA_API_URL = "https://gamma-api.polymarket.com";
const DATA_API_URL = "https://data-api.polymarket.com";

export class MarketDataService {
  private clobClient: ClobClient;

  constructor(clobClient: ClobClient) {
    this.clobClient = clobClient;
  }

  async getMarkets(limit: number = 100, active: boolean = true): Promise<Market[]> {
    try {
      const url = `${GAMMA_API_URL}/markets?limit=${limit}&active=${active}`;
      const markets = await fetchData<Market[]>(url);
      return markets;
    } catch (error) {
      logger.error("Failed to fetch markets:", error);
      return [];
    }
  }

  async getMarket(conditionId: string): Promise<Market | null> {
    try {
      const url = `${GAMMA_API_URL}/markets/${conditionId}`;
      const market = await fetchData<Market>(url);
      
      // Validate market has required fields
      if (!market || !market.conditionId || !market.question) {
        return null;
      }
      
      return market;
    } catch (error: any) {
      // Don't log 422 errors (invalid IDs) as errors, just debug
      if (error?.response?.status === 422) {
        logger.debug(`Invalid market ID ${conditionId}: ${error.response?.data?.error || 'id is invalid'}`);
      } else {
        logger.debug(`Failed to fetch market ${conditionId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      return null;
    }
  }

  async getOrderBook(tokenId: string): Promise<OrderBook | null> {
    try {
      const orderBook = await this.clobClient.getOrderBook(tokenId);
      return orderBook as OrderBook;
    } catch (error) {
      logger.error(`Failed to fetch order book for ${tokenId}:`, error);
      return null;
    }
  }

  async getMidPrice(tokenId: string): Promise<number | null> {
    try {
      const midPrice = await this.clobClient.getMidpoint(tokenId);
      return parseFloat(midPrice);
    } catch (error) {
      logger.error(`Failed to fetch mid price for ${tokenId}:`, error);
      return null;
    }
  }

  async getPrice(tokenId: string, side: "BUY" | "SELL"): Promise<number | null> {
    try {
      const price = await this.clobClient.getPrice(tokenId, side);
      return parseFloat(price);
    } catch (error) {
      logger.error(`Failed to fetch ${side} price for ${tokenId}:`, error);
      return null;
    }
  }

  async getUserPositions(walletAddress: string): Promise<UserPosition[]> {
    try {
      const url = `${DATA_API_URL}/positions?user=${walletAddress}`;
      const positions = await fetchData<UserPosition[]>(url);
      return positions;
    } catch (error) {
      logger.error(`Failed to fetch positions for ${walletAddress}:`, error);
      return [];
    }
  }

  async searchMarkets(query: string): Promise<Market[]> {
    try {
      const url = `${GAMMA_API_URL}/markets?_q=${encodeURIComponent(query)}`;
      const markets = await fetchData<Market[]>(url);
      return markets;
    } catch (error) {
      logger.error(`Failed to search markets for "${query}":`, error);
      return [];
    }
  }

  /**
   * Get market by slug (from Polymarket URL) or search query
   */
  async getMarketBySlug(slug: string): Promise<Market | null> {
    try {
      // Extract key terms from slug for searching
      const searchTerms = slug
        .replace(/-/g, " ")
        .replace(/\d+/g, "")
        .trim()
        .split(" ")
        .filter((t) => t.length > 2)
        .slice(0, 3)
        .join(" ");

      // Try searching for the market
      const markets = await this.searchMarkets(searchTerms);
      
      // Try to match by slug first
      let market = markets.find((m) => m.slug === slug || m.slug.includes(slug));
      if (market) {
        return market;
      }

      // Try to match by partial slug
      const slugParts = slug.split("-");
      for (const part of slugParts) {
        if (part.length > 5) {
          market = markets.find((m) => m.slug.includes(part));
          if (market) return market;
        }
      }

      // If still not found, search in all active markets
      const allMarkets = await this.getMarkets(200, true);
      market = allMarkets.find((m) => 
        m.slug === slug || 
        m.slug.includes(slug) ||
        slugParts.some((part) => part.length > 5 && m.slug.includes(part))
      );

      return market || null;
    } catch (error) {
      logger.debug(`Failed to find market by slug ${slug}:`, error);
      return null;
    }
  }
}

export default MarketDataService;
