import type { PreFilterOptions, PreFilterResult } from './types.ts';
import { TokenWeightProfiler } from './tokenWeightProfiler.ts';

/**
 * Domain Pre-Filter: Discards irrelevant betting data, expired fixtures, dead markets,
 * and high-token noise prior to heavy ML and LLM passes.
 */
export class DomainPreFilter {
    private static DEFAULT_SALIENT_KEYS = [
        'id', 'eventId', 'matchId', 'fixture', 'homeTeam', 'awayTeam', 'home', 'away',
        'date', 'time', 'status', 'odds', 'markets', 'moneyline', 'spread', 'overUnder',
        'probabilities', 'impliedProbability', 'form', 'h2h', 'recentResults', 'injuries',
        'score', 'competition', 'league', 'target'
    ];

    private static NOISY_FIELDS = [
        'debug', 'logs', 'telemetry', 'traceId', 'requestId', 'rawResponse',
        'httpStatus', 'headers', 'internalFlags', 'breadcrumbs', 'stackTrace',
        'unsupportedMarkets', 'obsoleteOdds', 'advertising', 'widgetConfig'
    ];

    public filter(payload: any, options: PreFilterOptions = {}): PreFilterResult {
        const profiler = new TokenWeightProfiler();
        const rawJson = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const originalByteSize = rawJson.length;
        const originalEstimatedTokens = profiler.estimateTokens(payload);

        let dataObj: any;
        try {
            dataObj = typeof payload === 'string' ? JSON.parse(payload) : JSON.parse(JSON.stringify(payload));
        } catch {
            return {
                filteredData: payload,
                originalByteSize,
                filteredByteSize: originalByteSize,
                originalEstimatedTokens,
                filteredEstimatedTokens: originalEstimatedTokens,
                tokensSaved: 0,
                prunedFieldsCount: 0,
                prunedRecordsCount: 0,
                reductionRatio: 0
            };
        }

        let prunedFieldsCount = 0;
        let prunedRecordsCount = 0;

        const maxMatches = options.maxMatches ?? 50;

        // Fast-path for large quantitative betting datasets (like duelodds array of match/market objects)
        // Bypasses heavy recursive AST traversal.
        if (Array.isArray(dataObj) && dataObj.length > 0) {
            const firstItem = dataObj[0];
            if (typeof firstItem === 'object' && firstItem !== null && ('odds' in firstItem || 'markets' in firstItem || 'fixture' in firstItem)) {
                let fastFiltered: any[] = [];
                for (let i = 0; i < dataObj.length; i++) {
                    if (fastFiltered.length >= maxMatches) {
                        prunedRecordsCount += (dataObj.length - i);
                        break;
                    }
                    const item = dataObj[i];
                    if (typeof item === 'object' && item !== null) {
                        if (options.dropClosedMatches) {
                            const st = (item.status || item.matchStatus || '').toLowerCase();
                            if (st === 'finished' || st === 'completed' || st === 'canceled' || st === 'abandoned') {
                                prunedRecordsCount++;
                                continue;
                            }
                        }
                        if (options.minLiquidityVolume !== undefined && options.minLiquidityVolume > 0) {
                            const vol = Number(item.volume ?? item.liquidity ?? item.poolSize ?? Infinity);
                            if (vol < options.minLiquidityVolume) {
                                prunedRecordsCount++;
                                continue;
                            }
                        }
                        fastFiltered.push(item);
                    } else {
                        fastFiltered.push(item);
                    }
                }

                const filteredJson = JSON.stringify(fastFiltered);
                const filteredByteSize = filteredJson.length;
                const filteredEstimatedTokens = profiler.estimateTokens(fastFiltered);
                const tokensSaved = Math.max(0, originalEstimatedTokens - filteredEstimatedTokens);
                const reductionRatio = originalEstimatedTokens > 0 ? Math.round((tokensSaved / originalEstimatedTokens) * 1000) / 1000 : 0;

                return {
                    filteredData: fastFiltered,
                    originalByteSize,
                    filteredByteSize,
                    originalEstimatedTokens,
                    filteredEstimatedTokens,
                    tokensSaved,
                    prunedFieldsCount: 0,
                    prunedRecordsCount,
                    reductionRatio
                };
            }
        }

        const salientSet = new Set(options.salientKeys || DomainPreFilter.DEFAULT_SALIENT_KEYS);
        const stripVerbose = options.stripVerboseFields !== false;
        const stripStale = options.stripStaleOdds !== false;

        // Recursive field cleaner
        const cleanNode = (node: any): any => {
            if (node === null || node === undefined) return node;

            if (Array.isArray(node)) {
                let filteredArr = node;
                // Filter closed / dead matches if requested
                if (options.dropClosedMatches) {
                    const prevLen = filteredArr.length;
                    filteredArr = filteredArr.filter(item => {
                        if (typeof item === 'object' && item !== null) {
                            const status = (item.status || item.matchStatus || '').toLowerCase();
                            if (status === 'finished' || status === 'completed' || status === 'canceled' || status === 'abandoned') {
                                return false;
                            }
                        }
                        return true;
                    });
                    prunedRecordsCount += (prevLen - filteredArr.length);
                }

                // Filter low liquidity if requested
                if (options.minLiquidityVolume !== undefined && options.minLiquidityVolume > 0) {
                    const prevLen = filteredArr.length;
                    filteredArr = filteredArr.filter(item => {
                        if (typeof item === 'object' && item !== null) {
                            const vol = Number(item.volume ?? item.liquidity ?? item.poolSize ?? Infinity);
                            return vol >= options.minLiquidityVolume!;
                        }
                        return true;
                    });
                    prunedRecordsCount += (prevLen - filteredArr.length);
                }

                if (filteredArr.length > maxMatches) {
                    prunedRecordsCount += (filteredArr.length - maxMatches);
                    filteredArr = filteredArr.slice(0, maxMatches);
                }

                return filteredArr.map(item => cleanNode(item));
            }

            if (typeof node === 'object') {
                const cleaned: Record<string, any> = {};
                for (const [k, v] of Object.entries(node)) {
                    // Check noisy fields
                    if (stripVerbose && DomainPreFilter.NOISY_FIELDS.includes(k.toLowerCase())) {
                        prunedFieldsCount++;
                        continue;
                    }

                    // Check stale odds
                    if (stripStale && (k === 'stale' || k === 'isStale' || k === 'suspended') && v === true) {
                        prunedFieldsCount++;
                        continue;
                    }

                    // Prune empty arrays / empty objects
                    if (typeof v === 'object' && v !== null) {
                        const cleanedSub = cleanNode(v);
                        if (Array.isArray(cleanedSub) && cleanedSub.length === 0) {
                            prunedFieldsCount++;
                            continue;
                        }
                        if (!Array.isArray(cleanedSub) && Object.keys(cleanedSub).length === 0) {
                            prunedFieldsCount++;
                            continue;
                        }
                        cleaned[k] = cleanedSub;
                    } else {
                        cleaned[k] = v;
                    }
                }
                return cleaned;
            }

            return node;
        };

        const filteredData = cleanNode(dataObj);
        const filteredJson = JSON.stringify(filteredData);
        const filteredByteSize = filteredJson.length;
        const filteredEstimatedTokens = profiler.estimateTokens(filteredData);
        const tokensSaved = Math.max(0, originalEstimatedTokens - filteredEstimatedTokens);
        const reductionRatio = originalEstimatedTokens > 0 ? Math.round((tokensSaved / originalEstimatedTokens) * 1000) / 1000 : 0;

        return {
            filteredData,
            originalByteSize,
            filteredByteSize,
            originalEstimatedTokens,
            filteredEstimatedTokens,
            tokensSaved,
            prunedFieldsCount,
            prunedRecordsCount,
            reductionRatio
        };
    }
}

export const globalDomainPreFilter = new DomainPreFilter();
