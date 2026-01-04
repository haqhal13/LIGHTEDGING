/**
 * Parameter loader with hot-reload support for params_latest.json
 */
import * as fs from 'fs';
import * as path from 'path';

export interface EntryParams {
    up_price_min: number | null;
    up_price_max: number | null;
    down_price_min: number | null;
    down_price_max: number | null;
    momentum_window_s: number;
    momentum_threshold: number;
    mode: 'momentum' | 'reversion' | 'none' | 'inventory-gated';
}

export interface SizeParams {
    bin_edges: number[]; // Price bucket edges (20 buckets: 0.0, 0.05, ..., 1.0)
    size_table: Record<string, number>; // 2D table: "price_bucket|inventory_bucket" -> size, or 1D if conditioning_var is null
    size_table_1d?: Record<string, number>; // Fallback 1D table: "price_bucket" -> size
    size_table_2d?: Record<string, number>; // 2D fallback table (if 3D exists)
    conditioning_var?: string | null; // null or "inventory_imbalance_ratio" or array
    conditioning_vars?: string[]; // List of conditioning variables
    inventory_buckets?: string[]; // e.g., ["bucket_0", "bucket_1", ...]
    inventory_bucket_thresholds?: number[]; // Thresholds for inventory buckets (strictly increasing)
    n_inventory_buckets?: number;
    volatility_buckets?: string[] | null;
    n_price_buckets?: number;
    has_volatility_conditioning?: boolean;
}

export interface InventoryParams {
    rebalance_ratio_R: number;
    max_up_shares: number;
    max_down_shares: number;
    max_total_shares: number;
}

export interface CadenceParams {
    min_inter_trade_ms: number;
    p50_inter_trade_ms: number;
    p95_inter_trade_ms: number;
    max_trades_per_sec: number;
    max_trades_per_min: number;
}

export interface SideSelectionParams {
    mode: 'inventory_driven' | 'edge_driven' | 'alternating' | 'fixed_preference' | 'mixed' | 'momentum_driven';
    inventory_driven_score?: number;
    alternation_score?: number;
    edge_driven_score?: number;
    momentum_driven_score?: number;
    fixed_preference_score?: number;
    confidence_gap?: number; // top_score - second_score
    losing_side_accumulation?: number; // Warning flag if > 0.55
    preferred_side?: 'UP' | 'DOWN' | null;
}

export interface ExecutionParams {
    model_type: 'snapshot_price' | 'mid_price' | 'worst_case' | 'fixed_slippage';
    fill_bias_median: number;
    fill_bias_mean?: number;
    fill_bias_std?: number;
    fill_bias_p25?: number;
    fill_bias_p75?: number;
    slippage_offset: number;
}

export interface CooldownParams {
    has_time_cooldown: boolean;
    time_cooldown_seconds: number;
    price_move_threshold: number | null;
    has_inventory_lockout: boolean;
    inventory_lockout_threshold: number | null;
}

export interface RiskParams {
    max_trades_per_session: number | null;
    max_imbalance_ratio: number;
    max_exposure_up_shares: number;
    max_exposure_down_shares: number;
}

export interface UnwindParams {
    has_unwind: boolean;
    unwind_start_ratio: number | null;
    reduces_without_rebalance: boolean;
}

export interface ResetParams {
    resets_on_market_switch: boolean;
    resets_on_inactivity: boolean;
    inactivity_threshold_hours: number;
}

export interface QualityFilterParams {
    max_price_sum_deviation: number;
    timestamp_jump_threshold_seconds: number;
    price_gap_threshold: number;
}

export interface MarketParams {
    entry_params?: EntryParams;
    size_params?: SizeParams;
    inventory_params?: InventoryParams;
    cadence_params?: CadenceParams;
    side_selection_params?: SideSelectionParams;
    execution_params?: ExecutionParams;
    cooldown_params?: CooldownParams;
    risk_params?: RiskParams;
    unwind_params?: UnwindParams;
    reset_params?: ResetParams;
    quality_filter_params?: QualityFilterParams;
}

// Support both old format (param-type-first) and new format (market-first)
export interface ParameterFile {
    // Old format: param-type-first
    entry_params?: {
        per_market: Record<string, EntryParams>;
    };
    size_params?: {
        per_market: Record<string, SizeParams>;
    };
    inventory_params?: {
        per_market: Record<string, InventoryParams>;
    };
    cadence_params?: {
        per_market: Record<string, CadenceParams>;
    };
    // New format: market-first (BTC_15m, ETH_15m, BTC_1h, ETH_1h as top-level keys)
    [market: string]: {
        entry_params?: EntryParams;
        size_params?: SizeParams;
        inventory_params?: InventoryParams;
        cadence_params?: CadenceParams;
        side_selection_params?: SideSelectionParams;
        execution_params?: ExecutionParams;
        cooldown_params?: CooldownParams;
        risk_params?: RiskParams;
        unwind_params?: UnwindParams;
        reset_params?: ResetParams;
        quality_filter_params?: QualityFilterParams;
        confidence?: any;
    } | {
        per_market: Record<string, any>;
    } | undefined;
}

class ParameterLoader {
    private params: ParameterFile | null = null;
    private paramsPath: string;
    private lastModified: number = 0;
    private pollInterval: NodeJS.Timeout | null = null;
    private listeners: Array<(params: ParameterFile) => void> = [];

    constructor(paramsPath: string = 'watch_bot_analyzer/output/params_latest.json') {
        this.paramsPath = path.resolve(paramsPath);
    }

    /**
     * Load parameters from file with validation and defaults
     */
    loadParams(): ParameterFile {
        try {
            if (!fs.existsSync(this.paramsPath)) {
                console.warn(`Parameter file not found: ${this.paramsPath}, using defaults`);
                return this.getDefaultParams();
            }

            const fileContent = fs.readFileSync(this.paramsPath, 'utf8');
            const parsed = JSON.parse(fileContent) as any;

            // Detect format: new format has market keys (BTC_15m, ETH_15m, etc.) as top-level
            const isNewFormat = this.isNewFormat(parsed);
            
            // Convert new format to old format for compatibility
            const normalized = isNewFormat ? this.convertNewToOldFormat(parsed) : parsed;

            // Validate structure
            this.validateParams(normalized);

            // Update timestamp
            const stats = fs.statSync(this.paramsPath);
            this.lastModified = stats.mtimeMs;

            this.params = normalized;
            return normalized;
        } catch (error) {
            console.error(`Error loading parameters from ${this.paramsPath}:`, error);
            return this.getDefaultParams();
        }
    }

    /**
     * Check if params file is in new format (market-first)
     */
    private isNewFormat(params: any): boolean {
        // New format has market keys like "BTC_15m", "ETH_15m", etc. as top-level
        // Old format has "entry_params", "size_params", etc. as top-level
        const marketKeys = ['BTC_15m', 'ETH_15m', 'BTC_1h', 'ETH_1h'];
        const hasMarketKey = marketKeys.some(key => key in params);
        const hasOldFormatKey = 'entry_params' in params || 'size_params' in params;
        
        // If it has market keys but not old format keys, it's new format
        return hasMarketKey && !hasOldFormatKey;
    }

    /**
     * Convert new format (market-first) to old format (param-type-first) for compatibility
     */
    private convertNewToOldFormat(newFormat: any): ParameterFile {
        const oldFormat: ParameterFile = {
            entry_params: { per_market: {} },
            size_params: { per_market: {} },
            inventory_params: { per_market: {} },
            cadence_params: { per_market: {} }
        };

        // Iterate through market keys (BTC_15m, ETH_15m, etc.)
        for (const marketKey in newFormat) {
            // Skip if it's not a market key (e.g., metadata)
            if (!['BTC_15m', 'ETH_15m', 'BTC_1h', 'ETH_1h'].includes(marketKey)) {
                continue;
            }

            const marketParams = newFormat[marketKey];
            
            if (marketParams.entry_params) {
                oldFormat.entry_params!.per_market[marketKey] = marketParams.entry_params;
            }
            if (marketParams.size_params) {
                oldFormat.size_params!.per_market[marketKey] = marketParams.size_params;
            }
            if (marketParams.inventory_params) {
                oldFormat.inventory_params!.per_market[marketKey] = marketParams.inventory_params;
            }
            if (marketParams.cadence_params) {
                oldFormat.cadence_params!.per_market[marketKey] = marketParams.cadence_params;
            }
            // Note: New params are kept in market-first format, not converted
            // They will be accessed directly from the new format structure
        }

        return oldFormat;
    }

    /**
     * Get default parameters if file doesn't exist or is invalid
     */
    private getDefaultParams(): ParameterFile {
        return {
            entry_params: { per_market: {} },
            size_params: { per_market: {} },
            inventory_params: { per_market: {} },
            cadence_params: { per_market: {} }
        };
    }

    /**
     * Validate parameter structure
     */
    private validateParams(params: ParameterFile): void {
        // Basic validation - ensure structure exists (old format)
        if (!params.entry_params) params.entry_params = { per_market: {} };
        if (!params.size_params) params.size_params = { per_market: {} };
        if (!params.inventory_params) params.inventory_params = { per_market: {} };
        if (!params.cadence_params) params.cadence_params = { per_market: {} };

        // Validate per-market entries have expected structure
        // (Could add more detailed validation here)
    }

    /**
     * Get current parameters (loads if not already loaded)
     */
    getParams(): ParameterFile {
        if (!this.params) {
            this.params = this.loadParams();
        }
        return this.params;
    }

    /**
     * Get parameters for a specific market
     */
    getMarketParams(marketKey: string): MarketParams {
        const params = this.getParams();
        
        // Convert market key format (e.g., "BTC-UpDown-15" -> "BTC_15m")
        const normalizedKey = this.normalizeMarketKey(marketKey);

        // Check if params are in new format (market-first)
        const isNewFormat = this.isNewFormat(params);
        
        if (isNewFormat && normalizedKey in params) {
            // New format: params are already market-first
            const marketParams = params[normalizedKey] as any;
            return {
                entry_params: marketParams.entry_params,
                size_params: marketParams.size_params,
                inventory_params: marketParams.inventory_params,
                cadence_params: marketParams.cadence_params,
                side_selection_params: marketParams.side_selection_params,
                execution_params: marketParams.execution_params,
                cooldown_params: marketParams.cooldown_params,
                risk_params: marketParams.risk_params,
                unwind_params: marketParams.unwind_params,
                reset_params: marketParams.reset_params,
                quality_filter_params: marketParams.quality_filter_params
            };
        } else {
            // Old format: param-type-first
            return {
                entry_params: params.entry_params?.per_market[normalizedKey],
                size_params: params.size_params?.per_market[normalizedKey],
                inventory_params: params.inventory_params?.per_market[normalizedKey],
                cadence_params: params.cadence_params?.per_market[normalizedKey]
            };
        }
    }

    /**
     * Normalize market key to match parameter file format
     * "BTC-UpDown-15" -> "BTC_15m"
     * "ETH-UpDown-15" -> "ETH_15m"
     * "BTC-UpDown-1h" -> "BTC_1h"
     * "ETH-UpDown-1h" -> "ETH_1h"
     */
    private normalizeMarketKey(marketKey: string): string {
        // Handle different formats
        if (marketKey.includes('BTC') && marketKey.includes('15')) return 'BTC_15m';
        if (marketKey.includes('ETH') && marketKey.includes('15')) return 'ETH_15m';
        if (marketKey.includes('BTC') && (marketKey.includes('1h') || marketKey.includes('1 hour'))) return 'BTC_1h';
        if (marketKey.includes('ETH') && (marketKey.includes('1h') || marketKey.includes('1 hour'))) return 'ETH_1h';
        
        // Try direct match
        return marketKey;
    }

    /**
     * Start hot-reload polling (safe + atomic)
     */
    startHotReload(pollIntervalMs: number = 3000): void {
        if (this.pollInterval) {
            return; // Already running
        }

        // Initial load
        this.params = this.loadParams();

        this.pollInterval = setInterval(() => {
            try {
                if (!fs.existsSync(this.paramsPath)) {
                    return;
                }

                const stats = fs.statSync(this.paramsPath);
                if (stats.mtimeMs > this.lastModified) {
                    // File changed, reload atomically
                    const newParams = this.loadParams();
                    this.params = newParams;

                    // Notify listeners
                    this.listeners.forEach(listener => {
                        try {
                            listener(newParams);
                        } catch (error) {
                            console.error('Error in parameter reload listener:', error);
                        }
                    });

                    console.log(`Parameters reloaded from ${this.paramsPath}`);
                }
            } catch (error) {
                console.error('Error checking parameter file:', error);
            }
        }, pollIntervalMs);

        console.log(`Hot-reload started for ${this.paramsPath} (polling every ${pollIntervalMs}ms)`);
    }

    /**
     * Stop hot-reload polling
     */
    stopHotReload(): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    /**
     * Add listener for parameter reload events
     */
    onReload(listener: (params: ParameterFile) => void): void {
        this.listeners.push(listener);
    }

    /**
     * Remove listener
     */
    offReload(listener: (params: ParameterFile) => void): void {
        const index = this.listeners.indexOf(listener);
        if (index > -1) {
            this.listeners.splice(index, 1);
        }
    }
}

// Singleton instance
let loaderInstance: ParameterLoader | null = null;

export function getParamLoader(paramsPath?: string): ParameterLoader {
    if (!loaderInstance) {
        loaderInstance = new ParameterLoader(paramsPath);
    }
    return loaderInstance;
}

export function loadParams(paramsPath?: string): ParameterFile {
    return getParamLoader(paramsPath).getParams();
}

