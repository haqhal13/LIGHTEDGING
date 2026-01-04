import axios from "axios";

const GAMMA_API_URL = "https://gamma-api.polymarket.com";

/**
 * Find condition IDs for markets from Polymarket URLs or search terms
 */
export async function findMarketConditionIds(
  slugsOrQueries: string[]
): Promise<string[]> {
  const conditionIds: string[] = [];

  for (const identifier of slugsOrQueries) {
    try {
      // Try as condition ID first
      if (identifier.startsWith("0x") && identifier.length >= 10) {
        conditionIds.push(identifier);
        continue;
      }

      // Search for market
      const searchQuery = identifier
        .replace(/-/g, " ")
        .replace(/\d{10,}/g, "") // Remove timestamps
        .trim();

      const response = await axios.get(
        `${GAMMA_API_URL}/markets?_q=${encodeURIComponent(searchQuery)}`
      );
      const markets = response.data || [];

      // Try to find matching market
      let found = markets.find(
        (m: any) =>
          m.slug === identifier ||
          m.slug?.includes(identifier) ||
          identifier.includes(m.slug?.split("-")[0] || "")
      );

      // If not found, search in all active markets
      if (!found) {
        const allMarketsResponse = await axios.get(
          `${GAMMA_API_URL}/markets?limit=200&active=true`
        );
        const allMarkets = allMarketsResponse.data || [];

        // Search for BTC/ETH Up/Down markets
        const keywords = identifier.toLowerCase();
        const isBTC = keywords.includes("btc") || keywords.includes("bitcoin");
        const isETH = keywords.includes("eth") || keywords.includes("ethereum");
        const is15m = keywords.includes("15m") || keywords.includes("15-min");
        const is1h = keywords.includes("1h") || keywords.includes("1-hour") || keywords.includes("1pm");

        found = allMarkets.find((m: any) => {
          const question = (m.question || "").toLowerCase();
          const slug = (m.slug || "").toLowerCase();

          const matchesAsset = (isBTC && (question.includes("bitcoin") || question.includes("btc"))) ||
                              (isETH && (question.includes("ethereum") || question.includes("eth")));
          
          const matchesTime = (is15m && (question.includes("1:45") || question.includes("15"))) ||
                             (is1h && (question.includes("1pm") || question.includes("1-2pm") || question.includes("1:00")));

          return matchesAsset && 
                 (question.includes("up") || question.includes("down")) &&
                 (matchesTime || !is15m && !is1h) &&
                 question.includes("january 3");
        });
      }

      if (found && found.conditionId) {
        conditionIds.push(found.conditionId);
        console.log(`Found: ${identifier} -> ${found.conditionId}`);
      } else {
        console.log(`Not found: ${identifier}`);
      }
    } catch (error) {
      console.error(`Error searching for ${identifier}:`, error);
    }
  }

  return conditionIds;
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    findMarketConditionIds(args).then((ids) => {
      console.log("\nCondition IDs found:");
      console.log(ids.join(","));
    });
  }
}
