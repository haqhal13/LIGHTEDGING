import dotenv from "dotenv";

dotenv.config();

// Default trader to watch if USER_ADDRESSES isn't provided
const DEFAULT_USER_ADDRESSES = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';

function getEnvVar(key: string, required: boolean = true): string {
  const value = process.env[key];
  if (required && !value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value || "";
}

function getEnvVarNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
}

function getEnvVarFloat(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseFloat(value) : defaultValue;
}

function getEnvVarBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === "true";
}

/**
 * Validate Ethereum address format
 */
const isValidEthereumAddress = (address: string): boolean => {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
};

/**
 * Parse USER_ADDRESSES: supports both comma-separated string and JSON array
 */
const parseUserAddresses = (input: string): string[] => {
  if (!input || input.trim() === '') {
    console.log(`ℹ️  USER_ADDRESSES not set; defaulting to ${DEFAULT_USER_ADDRESSES}`);
    return [DEFAULT_USER_ADDRESSES.toLowerCase()];
  }

  const trimmed = input.trim();
  // Check if it's JSON array format
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((addr) => addr.toLowerCase().trim())
          .filter((addr) => addr.length > 0 && isValidEthereumAddress(addr));
      }
    } catch (e) {
      console.error('Invalid JSON format for USER_ADDRESSES:', e);
    }
  }
  // Otherwise treat as comma-separated
  return trimmed
    .split(',')
    .map((addr) => addr.toLowerCase().trim())
    .filter((addr) => addr.length > 0 && isValidEthereumAddress(addr));
};

// Paper mode doesn't require wallet credentials
const isPaperMode = getEnvVarBoolean("PAPER_MODE", false);
const isWatcherMode = getEnvVarBoolean("WATCHER_MODE", false);
const isTrackOnlyMode = getEnvVarBoolean("TRACK_ONLY_MODE", false) || isWatcherMode;

export const ENV = {
  // Trading mode
  PAPER_MODE: isPaperMode,
  WATCHER_MODE: isWatcherMode,
  TRACK_ONLY_MODE: isTrackOnlyMode,

  // Wallet config (not required in paper mode)
  USER_ADDRESS: getEnvVar("USER_ADDRESS", !isPaperMode && !isTrackOnlyMode),
  USER_ADDRESSES: parseUserAddresses(getEnvVar("USER_ADDRESSES", false)), // Array of trader addresses to track
  PROXY_WALLET: getEnvVar("PROXY_WALLET", !isPaperMode && !isTrackOnlyMode),
  PRIVATE_KEY: getEnvVar("PRIVATE_KEY", !isPaperMode && !isTrackOnlyMode),

  // API endpoints
  CLOB_HTTP_URL: getEnvVar("CLOB_HTTP_URL", false) || "https://clob.polymarket.com",
  CLOB_WS_URL: getEnvVar("CLOB_WS_URL", false) || "wss://ws-subscriptions-clob.polymarket.com/ws/market",

  // Blockchain
  RPC_URL: getEnvVar("RPC_URL", false) || "https://polygon-rpc.com",
  USDC_CONTRACT_ADDRESS: getEnvVar("USDC_CONTRACT_ADDRESS", false) || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",

  // Database
  MONGO_URI: getEnvVar("MONGO_URI", false) || "mongodb://localhost:27017/lightedge_polymarket",

  // Bot settings
  FETCH_INTERVAL: getEnvVarFloat("FETCH_INTERVAL", 1),
  TOO_OLD_TIMESTAMP: getEnvVarNumber("TOO_OLD_TIMESTAMP", 24),
  RETRY_LIMIT: getEnvVarNumber("RETRY_LIMIT", 3),
  REQUEST_TIMEOUT_MS: getEnvVarNumber("REQUEST_TIMEOUT_MS", 10000),
  NETWORK_RETRY_LIMIT: getEnvVarNumber("NETWORK_RETRY_LIMIT", 3),

  // Paper trading settings
  PAPER_BALANCE: getEnvVarNumber("PAPER_BALANCE", 10000),
  PAPER_STARTING_CAPITAL: getEnvVarNumber("PAPER_STARTING_CAPITAL", 10000),

  // Dashboard settings
  DASHBOARD_UPDATE_INTERVAL: getEnvVarNumber("DASHBOARD_UPDATE_INTERVAL", 500), // 500ms for responsive updates
  DASHBOARD_MARKETS: getEnvVar("DASHBOARD_MARKETS", false), // Comma-separated condition IDs
  DISPLAY_MAX_AGE_MINUTES: process.env.DISPLAY_MAX_AGE_MINUTES
    ? parseFloat(process.env.DISPLAY_MAX_AGE_MINUTES)
    : undefined,
};

export default ENV;
