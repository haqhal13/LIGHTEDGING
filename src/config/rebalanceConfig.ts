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

  // Market-specific trade sizing (1-hour vs 15-minute)
  // 1-Hour markets (conservative)
  sizing_1h_base: number;
  sizing_1h_multiplier: number;
  sizing_1h_min_trade: number;
  sizing_1h_max_trade: number;
  sizing_1h_cooldown_sec: number;
  // 15-Minute markets (aggressive)
  sizing_15m_base: number;
  sizing_15m_multiplier: number;
  sizing_15m_min_trade: number;
  sizing_15m_max_trade: number;
  sizing_15m_cooldown_sec: number;

  // Price / execution safety
  slippage_buffer: number;
  order_type: "limit" | "market";
  limit_price_offset: number;
  max_unfilled_time_sec: number;

  // Inventory risk controls
  max_inventory_imbalance_ratio: number;
  stop_add_threshold: number;
  reduce_only_mode: boolean;

  // Tilt trading (aggressive when winning)
  tilt_threshold: number;
  tilt_boost_multiplier: number;
  price_stop_threshold: number;

  // Bell curve sizing (maximize middle, minimize extremes)
  bell_curve_enabled: boolean;
  bell_curve_peak_multiplier: number;    // 1.50 at price 0.50
  bell_curve_extreme_multiplier: number; // 0.30 at price 0.10/0.90

  // Gabagool22 asset allocation (BTC vs ETH)
  btc_allocation_15m: number;  // 0.76 = 76% of 15m trades to BTC
  eth_allocation_15m: number;  // 0.24 = 24% of 15m trades to ETH
  btc_allocation_1h: number;   // 0.70 = 70% of 1h trades to BTC
  eth_allocation_1h: number;   // 0.30 = 30% of 1h trades to ETH

  // Gabagool22 market time allocation (15m vs 1h shifting)
  market_time_allocation_enabled: boolean;

  // Market close behavior (15-minute markets)
  close_reduce_activity_minutes: number;
  close_activity_multiplier: number;
  close_reduce_size_minutes: number;
  close_size_multiplier: number;
  close_stop_trading_seconds: number;

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
  min_trade_size: 0.01,
  max_trade_size: 26.0,
  // 1-Hour markets (conservative)
  sizing_1h_base: 0.50,
  sizing_1h_multiplier: 8.00,
  sizing_1h_min_trade: 0.01,
  sizing_1h_max_trade: 14.00,
  sizing_1h_cooldown_sec: 6,
  // 15-Minute markets (aggressive)
  sizing_15m_base: 0.25,
  sizing_15m_multiplier: 12.00,
  sizing_15m_min_trade: 0.01,
  sizing_15m_max_trade: 26.00,
  sizing_15m_cooldown_sec: 2,
  slippage_buffer: 0.005,
  order_type: "limit",
  limit_price_offset: 0.003,
  max_unfilled_time_sec: 60,
  max_inventory_imbalance_ratio: 1.5,
  stop_add_threshold: 0.80,
  reduce_only_mode: false,
  tilt_threshold: 0.59,
  tilt_boost_multiplier: 1.25,
  price_stop_threshold: 0.90,
  // Bell curve sizing (disabled for gabagool22)
  bell_curve_enabled: false,
  bell_curve_peak_multiplier: 1.0,
  bell_curve_extreme_multiplier: 1.0,
  // Gabagool22 asset allocation
  btc_allocation_15m: 0.76,
  eth_allocation_15m: 0.24,
  btc_allocation_1h: 0.70,
  eth_allocation_1h: 0.30,
  // Gabagool22 market time allocation
  market_time_allocation_enabled: true,
  // Market close behavior (15-minute markets)
  close_reduce_activity_minutes: 4,
  close_activity_multiplier: 0.25,
  close_reduce_size_minutes: 1,
  close_size_multiplier: 0.60,
  close_stop_trading_seconds: 0,
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
          logger.info(`   tilt_threshold: ${newConfig.tilt_threshold}`);
          logger.info(`   tilt_boost: ${newConfig.tilt_boost_multiplier}x`);
          logger.info(`   price_stop: ${newConfig.price_stop_threshold}`);
          logger.info(`   1h sizing: $${newConfig.sizing_1h_base} + (price × ${newConfig.sizing_1h_multiplier}), cooldown ${newConfig.sizing_1h_cooldown_sec}s`);
          logger.info(`   15m sizing: $${newConfig.sizing_15m_base} + (price × ${newConfig.sizing_15m_multiplier}), cooldown ${newConfig.sizing_15m_cooldown_sec}s`);
          logger.info(`   bell curve: ${newConfig.bell_curve_enabled ? `ON (peak ${newConfig.bell_curve_peak_multiplier}x @ 0.50, extreme ${newConfig.bell_curve_extreme_multiplier}x @ edges)` : 'OFF'}`);
          logger.info(`   close behavior: reduce freq at ${newConfig.close_reduce_activity_minutes}min (${newConfig.close_activity_multiplier * 100}%), reduce size at ${newConfig.close_reduce_size_minutes}min (${newConfig.close_size_multiplier * 100}%)`);

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
