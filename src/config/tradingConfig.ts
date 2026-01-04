/**
 * Canonical trading configuration schema
 * Used by BOTH watch mode (for validation) and paper mode (for execution)
 * 
 * Supports 4 markets: BTC_15m, ETH_15m, BTC_1h, ETH_1h
 */
import {
    EntryParams,
    SizeParams,
    InventoryParams,
    CadenceParams,
    SideSelectionParams,
    ExecutionParams,
    CooldownParams,
    RiskParams,
    UnwindParams,
    ResetParams,
    QualityFilterParams,
    MarketParams
} from '../services/paramLoader';

export type MarketKey = 'BTC_15m' | 'ETH_15m' | 'BTC_1h' | 'ETH_1h';

export interface TradingConfig {
    [market: string]: MarketParams;
}

/**
 * Validate that all required parameter types are present for a market
 */
export function validateMarketConfig(market: MarketKey, params: MarketParams): string[] {
    const missing: string[] = [];
    const required = [
        'entry_params',
        'size_params',
        'inventory_params',
        'cadence_params',
        'side_selection_params',
        'execution_params',
        'cooldown_params',
        'risk_params',
        'reset_params',
        'quality_filter_params'
    ];

    for (const paramType of required) {
        if (!(paramType in params) || params[paramType as keyof MarketParams] === undefined) {
            missing.push(paramType);
        }
    }

    return missing;
}

/**
 * Validate bin edges are strictly increasing
 */
export function validateBinEdges(binEdges: number[]): boolean {
    if (binEdges.length < 2) return false;
    for (let i = 1; i < binEdges.length; i++) {
        if (binEdges[i] <= binEdges[i - 1]) {
            return false;
        }
    }
    return true;
}

/**
 * Validate inventory bucket thresholds are strictly increasing
 */
export function validateInventoryThresholds(thresholds: number[]): boolean {
    if (thresholds.length < 2) return false;
    for (let i = 1; i < thresholds.length; i++) {
        if (thresholds[i] <= thresholds[i - 1]) {
            return false;
        }
    }
    return true;
}

/**
 * Generate assertion report listing missing config fields per market
 */
export function generateAssertionReport(config: TradingConfig): {
    valid: boolean;
    missingFields: Record<MarketKey, string[]>;
    validationErrors: Record<MarketKey, string[]>;
} {
    const missingFields: Record<string, string[]> = {};
    const validationErrors: Record<string, string[]> = {};
    const markets: MarketKey[] = ['BTC_15m', 'ETH_15m', 'BTC_1h', 'ETH_1h'];

    for (const market of markets) {
        const params = config[market];
        if (!params) {
            missingFields[market] = ['ALL_PARAMS_MISSING'];
            validationErrors[market] = ['Market not found in config'];
            continue;
        }

        // Check for missing parameter types
        const missing = validateMarketConfig(market, params);
        if (missing.length > 0) {
            missingFields[market] = missing;
        }

        // Validate size_params bin_edges
        if (params.size_params) {
            if (!validateBinEdges(params.size_params.bin_edges)) {
                validationErrors[market] = validationErrors[market] || [];
                validationErrors[market].push('size_params.bin_edges: not strictly increasing');
            }

            // Validate inventory_bucket_thresholds if present
            if (params.size_params.inventory_bucket_thresholds) {
                if (!validateInventoryThresholds(params.size_params.inventory_bucket_thresholds)) {
                    validationErrors[market] = validationErrors[market] || [];
                    validationErrors[market].push('size_params.inventory_bucket_thresholds: not strictly increasing');
                }
            }
        }
    }

    const valid = Object.keys(missingFields).length === 0 && Object.keys(validationErrors).length === 0;

    return {
        valid,
        missingFields: missingFields as Record<MarketKey, string[]>,
        validationErrors: validationErrors as Record<MarketKey, string[]>
    };
}
