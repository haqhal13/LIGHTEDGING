import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import logger from "../utils/logger";

// File watcher for hot-reloading
let configWatcher: fs.FSWatcher | null = null;
let configFilePath: string | null = null;

export interface RebalanceConfig {
  // Bankroll & allocation
  bankroll_total: number;
  target_yes_ratio: number;
  max_skew_ratio: number;

  // Rebalance trigger
  rebalance_band: number;
  price_move_threshold: number;
  min_seconds_between_rebalances: number;

  // Rebalance strength
  rebalance_strength_k: number;
  max_rebalance_step_pct: number;
  min_trade_size: number;
  max_trade_size: number;

  // Price-based trade sizing: trade_size = base_size + (price × price_multiplier)
  use_price_based_sizing: boolean;
  sizing_base: number;
  sizing_price_multiplier: number;

  // Price / execution safety
  slippage_buffer: number;
  order_type: "limit" | "market";
  limit_price_offset: number;
  max_unfilled_time_sec: number;

  // Inventory risk controls
  max_inventory_imbalance_ratio: number;
  stop_add_threshold: number;
  reduce_only_mode: boolean;

  // Reversal handling
  flip_detection_window_sec: number;
  flip_response_multiplier: number;
  post_flip_cooldown_sec: number;

  // Logging / tuning helpers
  log_every_trade: boolean;
  metrics_window_trades: number;

  // Market configuration
  market_condition_id: string;
}

const DEFAULT_CONFIG: RebalanceConfig = {
  bankroll_total: 100.0,
  target_yes_ratio: 0.5,
  max_skew_ratio: 0.15,
  rebalance_band: 0.05,
  price_move_threshold: 0.01,
  min_seconds_between_rebalances: 30,
  rebalance_strength_k: 0.5,
  max_rebalance_step_pct: 0.20,
  min_trade_size: 0.10,
  max_trade_size: 5.0,
  use_price_based_sizing: false,
  sizing_base: 1.0,
  sizing_price_multiplier: 11.0,
  slippage_buffer: 0.005,
  order_type: "limit",
  limit_price_offset: 0.003,
  max_unfilled_time_sec: 60,
  max_inventory_imbalance_ratio: 1.5,
  stop_add_threshold: 0.80,
  reduce_only_mode: false,
  flip_detection_window_sec: 30,
  flip_response_multiplier: 1.5,
  post_flip_cooldown_sec: 15,
  log_every_trade: true,
  metrics_window_trades: 100,
  market_condition_id: "",
};

let cachedConfig: RebalanceConfig | null = null;

/**
 * Load configuration from YAML file
 */
export function loadRebalanceConfig(configPath?: string): RebalanceConfig {
  // Return cached config if available (for performance)
  if (cachedConfig) {
    return cachedConfig;
  }

  const configFilePath =
    configPath || path.join(process.cwd(), "inventory-rebalance-config.yaml");

  try {
    if (!fs.existsSync(configFilePath)) {
      logger.warn(
        `Config file not found at ${configFilePath}, using default values`
      );
      cachedConfig = DEFAULT_CONFIG;
      return cachedConfig;
    }

    const fileContents = fs.readFileSync(configFilePath, "utf8");
    const loadedConfig = yaml.load(fileContents) as Partial<RebalanceConfig>;

    // Merge with defaults to ensure all fields are present
    cachedConfig = {
      ...DEFAULT_CONFIG,
      ...loadedConfig,
    };

    logger.info(`Loaded rebalance config from ${configFilePath}`);
    return cachedConfig;
  } catch (error) {
    logger.error(`Failed to load config from ${configFilePath}:`, error);
    logger.warn("Using default configuration values");
    cachedConfig = DEFAULT_CONFIG;
    return cachedConfig;
  }
}

/**
 * Reload configuration from file (useful for hot-reloading)
 */
export function reloadRebalanceConfig(configPath?: string): RebalanceConfig {
  cachedConfig = null;
  return loadRebalanceConfig(configPath);
}

/**
 * Get current cached config without reloading
 */
export function getRebalanceConfig(): RebalanceConfig {
  if (!cachedConfig) {
    return loadRebalanceConfig();
  }
  return cachedConfig;
}

/**
 * Start watching config file for changes (hot-reload)
 */
export function startConfigWatcher(onConfigChange?: (config: RebalanceConfig) => void): void {
  if (configWatcher) {
    return; // Already watching
  }

  const filePath = configFilePath || path.join(process.cwd(), "inventory-rebalance-config.yaml");

  try {
    let debounceTimer: NodeJS.Timeout | null = null;

    configWatcher = fs.watch(filePath, (eventType) => {
      if (eventType === "change") {
        // Debounce to avoid multiple reloads for a single save
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
          logger.info("🔄 Config file changed - hot-reloading...");
          const newConfig = reloadRebalanceConfig();

          // Log key changes
          logger.info(`📊 Hot-reload complete:`);
          logger.info(`   bankroll_total: $${newConfig.bankroll_total}`);
          logger.info(`   target_yes_ratio: ${(newConfig.target_yes_ratio * 100).toFixed(0)}%`);
          logger.info(`   min_trade_size: $${newConfig.min_trade_size}`);
          logger.info(`   max_trade_size: $${newConfig.max_trade_size}`);
          logger.info(`   rebalance_band: ${(newConfig.rebalance_band * 100).toFixed(1)}%`);
          logger.info(`   rebalance_strength_k: ${newConfig.rebalance_strength_k}`);
          if (newConfig.use_price_based_sizing) {
            logger.info(`   sizing: $${newConfig.sizing_base} + (price × $${newConfig.sizing_price_multiplier})`);
          }

          if (onConfigChange) {
            onConfigChange(newConfig);
          }
        }, 100); // 100ms debounce
      }
    });

    logger.info(`👁️ Watching config file for changes: ${filePath}`);
    logger.info("   Edit and save the config file - changes apply immediately!");
  } catch (error) {
    logger.error(`Failed to start config watcher: ${error}`);
  }
}

/**
 * Stop watching config file
 */
export function stopConfigWatcher(): void {
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
    logger.info("Config file watcher stopped");
  }
}
