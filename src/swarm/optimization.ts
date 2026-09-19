/**
 * High-Throughput Swarm Optimization for Betting & Real-Time Prediction Workloads.
 * 
 * Vectors addressed:
 * 1. Domain sub-computation caching (team form, H2H, market odds with TTL)
 * 2. Input metadata token weight profiling and baseline delta tracking
 * 3. Heuristic domain pre-filtering of irrelevant fields / stale markets
 * 4. Confidence-based early-exit logic to bypass heavy Tier 2 passes
 */

export type SubComputationDomain = 
    | 'team_form' 
    | 'head_to_head' 
    | 'market_odds' 
    | 'player_props' 
    | 'league_baseline' 
    | 'custom';

export interface SubComputationCacheEntry<T = any> {
    domain: SubComputationDomain;
    key: string;
    value: T;
    createdAt: number;
    expiresAt: number;
    hits: number;
}

export interface SubComputationCacheMetrics {
    totalEntries: number;
    hits: number;
    misses: number;
    hitRatio: number;
    subcomputationsSaved: number;
    evictions: number;
    domainBreakdown: Record<SubComputationDomain, { entries: number; hits: number; misses: number }>;
}

export interface SubComputationCacheConfig {
    defaultTtlMs?: number; // default: 300,000ms (5 minutes)
    maxEntries?: number;   // default: 1,000 entries
}

/**
 * High-throughput, TTL-bounded cache for frequent sub-computations.
 * Prevents redundant statistical recalculations and LLM prompt lookups.
 */
export class DomainSubComputationCache {
    private entries: Map<string, SubComputationCacheEntry> = new Map();
    private defaultTtlMs: number;
    private maxEntries: number;
    private hits: number = 0;
    private misses: number = 0;
    private evictions: number = 0;
    private subcomputationsSaved: number = 0;
    private domainStats: Record<SubComputationDomain, { entries: number; hits: number; misses: number }> = {
        team_form: { entries: 0, hits: 0, misses: 0 },
        head_to_head: { entries: 0, hits: 0, misses: 0 },
        market_odds: { entries: 0, hits: 0, misses: 0 },
        player_props: { entries: 0, hits: 0, misses: 0 },
        league_baseline: { entries: 0, hits: 0, misses: 0 },
        custom: { entries: 0, hits: 0, misses: 0 }
    };

    constructor(config: SubComputationCacheConfig = {}) {
        this.defaultTtlMs = config.defaultTtlMs ?? 300000; // 5 min
        this.maxEntries = config.maxEntries ?? 1000;
    }

    private makeCompositeKey(domain: SubComputationDomain, key: string): string {
        return `${domain}:${key.trim().toLowerCase()}`;
    }

    public get<T = any>(domain: SubComputationDomain, key: string): T | undefined {
        const compositeKey = this.makeCompositeKey(domain, key);
        const entry = this.entries.get(compositeKey);

        if (!entry) {
            this.misses++;
            if (this.domainStats[domain]) this.domainStats[domain].misses++;
            return undefined;
        }

        const now = Date.now();
        if (entry.expiresAt > 0 && now >= entry.expiresAt) {
            this.entries.delete(compositeKey);
            this.misses++;
            this.evictions++;
            if (this.domainStats[domain]) {
                this.domainStats[domain].misses++;
                this.domainStats[domain].entries = Math.max(0, this.domainStats[domain].entries - 1);
            }
            return undefined;
        }

        entry.hits++;
        this.hits++;
        this.subcomputationsSaved++;
        if (this.domainStats[domain]) this.domainStats[domain].hits++;

        // Refresh LRU position
        this.entries.delete(compositeKey);
        this.entries.set(compositeKey, entry);

        return entry.value as T;
    }

    public set<T = any>(domain: SubComputationDomain, key: string, value: T, ttlMs?: number): void {
        const compositeKey = this.makeCompositeKey(domain, key);
        const now = Date.now();
        const effectiveTtl = ttlMs !== undefined ? ttlMs : this.defaultTtlMs;
        const expiresAt = effectiveTtl > 0 ? now + effectiveTtl : 0;

        if (this.entries.has(compositeKey)) {
            const existing = this.entries.get(compositeKey)!;
            existing.value = value;
            existing.expiresAt = expiresAt;
            existing.createdAt = now;
            // Move to newest
            this.entries.delete(compositeKey);
            this.entries.set(compositeKey, existing);
            return;
        }

        if (this.entries.size >= this.maxEntries) {
            // Evict oldest entry (first item in Map iterator)
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey) {
                const oldEntry = this.entries.get(oldestKey);
                if (oldEntry && this.domainStats[oldEntry.domain]) {
                    this.domainStats[oldEntry.domain].entries = Math.max(0, this.domainStats[oldEntry.domain].entries - 1);
                }
                this.entries.delete(oldestKey);
                this.evictions++;
            }
        }

        this.entries.set(compositeKey, {
            domain,
            key,
            value,
            createdAt: now,
            expiresAt,
            hits: 0
        });

        if (this.domainStats[domain]) {
            this.domainStats[domain].entries++;
        }
    }

    public async getOrCompute<T = any>(
        domain: SubComputationDomain,
        key: string,
        computeFn: () => Promise<T> | T,
        ttlMs?: number
    ): Promise<T> {
        const cached = this.get<T>(domain, key);
        if (cached !== undefined) {
            return cached;
        }

        const computed = await computeFn();
        this.set<T>(domain, key, computed, ttlMs);
        return computed;
    }

    public invalidate(domain?: SubComputationDomain, key?: string): number {
        if (!domain && !key) {
            const count = this.entries.size;
            this.clear();
            return count;
        }

        let count = 0;
        if (domain && key) {
            const compositeKey = this.makeCompositeKey(domain, key);
            if (this.entries.delete(compositeKey)) {
                count++;
                if (this.domainStats[domain]) {
                    this.domainStats[domain].entries = Math.max(0, this.domainStats[domain].entries - 1);
                }
            }
        } else if (domain) {
            for (const [k, v] of this.entries.entries()) {
                if (v.domain === domain) {
                    this.entries.delete(k);
                    count++;
                }
            }
            if (this.domainStats[domain]) {
                this.domainStats[domain].entries = 0;
            }
        }
        return count;
    }

    public clear(): void {
        this.entries.clear();
        for (const dom of Object.keys(this.domainStats) as SubComputationDomain[]) {
            this.domainStats[dom].entries = 0;
        }
    }

    public getMetrics(): SubComputationCacheMetrics {
        const total = this.hits + this.misses;
        return {
            totalEntries: this.entries.size,
            hits: this.hits,
            misses: this.misses,
            hitRatio: total > 0 ? Math.round((this.hits / total) * 1000) / 1000 : 0,
            subcomputationsSaved: this.subcomputationsSaved,
            evictions: this.evictions,
            domainBreakdown: JSON.parse(JSON.stringify(this.domainStats))
        };
    }
}

export const globalDomainSubComputationCache = new DomainSubComputationCache();

export interface BaselineDifference {
    tokenDelta: number;
    tokenDivergenceRatio: number;
    baselineTokens: number;
    currentTokens: number;
    addedKeys: string[];
    removedKeys: string[];
    deviatingFields: Array<{ field: string; baselineTokens: number; currentTokens: number; growthPercent: number }>;
    isBloated: boolean;
    recommendation: string;
}

export interface TokenWeightReport {
    totalTokens: number;
    metadataTokens: number;
    dataTokens: number;
    metadataWeightRatio: number;
    fieldWeights: Record<string, number>;
    isBloated: boolean;
    baselineDiff?: BaselineDifference;
    recommendations: string[];
}

/**
 * Token Weight Profiler: Measures metadata weight and pinpoints token inflation
 * that causes LLM pipeline timeouts (>180s). Compares current payloads to historical baselines.
 */
export class TokenWeightProfiler {
    /**
     * Fast token estimator based on whitespace / character heuristic (~3.8 - 4.0 chars per token).
     */
    public estimateTokens(input: any): number {
        if (input === null || input === undefined) return 0;
        if (typeof input === 'number' || typeof input === 'boolean') return 1;
        if (typeof input === 'string') {
            return Math.max(1, Math.ceil(input.length / 3.8));
        }
        const jsonStr = JSON.stringify(input);
        return Math.max(1, Math.ceil(jsonStr.length / 3.8));
    }

    public profile(input: any, baseline?: any): TokenWeightReport {
        let parsed: Record<string, any> = {};
        if (typeof input === 'string') {
            try {
                parsed = JSON.parse(input);
            } catch {
                const total = this.estimateTokens(input);
                return {
                    totalTokens: total,
                    metadataTokens: 0,
                    dataTokens: total,
                    metadataWeightRatio: 0,
                    fieldWeights: { rawText: total },
                    isBloated: total > 2000,
                    recommendations: total > 2000 ? ['Pre-filter raw text payload to reduce token overhead'] : []
                };
            }
        } else if (typeof input === 'object' && input !== null) {
            parsed = input;
        }

        const totalTokens = this.estimateTokens(parsed);
        const fieldWeights: Record<string, number> = {};
        let metadataTokens = 0;
        let dataTokens = 0;

        const metadataKeyPattern = /^(metadata|meta|config|settings|headers|tags|params|options|telemetry|debug|tracking|context|system)/i;

        for (const [key, val] of Object.entries(parsed)) {
            const weight = this.estimateTokens(val);
            fieldWeights[key] = weight;

            if (metadataKeyPattern.test(key)) {
                metadataTokens += weight;
            } else {
                dataTokens += weight;
            }
        }

        const metadataWeightRatio = totalTokens > 0 ? Math.round((metadataTokens / totalTokens) * 1000) / 1000 : 0;
        const recommendations: string[] = [];

        if (metadataWeightRatio > 0.40) {
            recommendations.push(`Metadata accounts for ${Math.round(metadataWeightRatio * 100)}% of input. Strip non-salient metadata before LLM inference.`);
        }
        if (totalTokens > 3000) {
            recommendations.push(`Total tokens (${totalTokens}) risk 180s inference timeout. Apply chunking or pre-filtering.`);
        }

        let baselineDiff: BaselineDifference | undefined;
        if (baseline) {
            baselineDiff = this.diffBaselines(parsed, baseline);
            if (baselineDiff.isBloated) {
                recommendations.push(`Payload token weight grew by ${Math.round(baselineDiff.tokenDivergenceRatio * 100)}% over historical baseline. Prune bloated fields: ${baselineDiff.deviatingFields.map(f => f.field).join(', ')}.`);
            }
        }

        const isBloated = (totalTokens > 2500 && metadataWeightRatio > 0.35) || (baselineDiff?.isBloated ?? false);

        return {
            totalTokens,
            metadataTokens,
            dataTokens,
            metadataWeightRatio,
            fieldWeights,
            isBloated,
            baselineDiff,
            recommendations
        };
    }

    public diffBaselines(current: any, baseline: any): BaselineDifference {
        const currentObj = typeof current === 'string' ? (() => { try { return JSON.parse(current); } catch { return { raw: current }; } })() : (current || {});
        const baselineObj = typeof baseline === 'string' ? (() => { try { return JSON.parse(baseline); } catch { return { raw: baseline }; } })() : (baseline || {});

        const currentTokens = this.estimateTokens(currentObj);
        const baselineTokens = Math.max(1, this.estimateTokens(baselineObj));
        const tokenDelta = currentTokens - baselineTokens;
        const tokenDivergenceRatio = Math.round((tokenDelta / baselineTokens) * 1000) / 1000;

        const currentKeys = Object.keys(currentObj);
        const baselineKeys = Object.keys(baselineObj);

        const addedKeys = currentKeys.filter(k => !baselineKeys.includes(k));
        const removedKeys = baselineKeys.filter(k => !currentKeys.includes(k));

        const deviatingFields: Array<{ field: string; baselineTokens: number; currentTokens: number; growthPercent: number }> = [];

        for (const k of currentKeys) {
            if (baselineObj[k] !== undefined) {
                const bTokens = Math.max(1, this.estimateTokens(baselineObj[k]));
                const cTokens = this.estimateTokens(currentObj[k]);
                const growth = Math.round(((cTokens - bTokens) / bTokens) * 100);
                if (growth >= 50 && cTokens > 50) {
                    deviatingFields.push({
                        field: k,
                        baselineTokens: bTokens,
                        currentTokens: cTokens,
                        growthPercent: growth
                    });
                }
            }
        }

        const isBloated = tokenDivergenceRatio >= 0.50 || deviatingFields.length >= 2 || (tokenDelta > 1000);
        const recommendation = isBloated
            ? `Detected +${Math.round(tokenDivergenceRatio * 100)}% token expansion against baseline. Prune ${addedKeys.length} new keys and ${deviatingFields.length} inflated fields.`
            : `Token footprint within expected variance (${tokenDivergenceRatio >= 0 ? '+' : ''}${Math.round(tokenDivergenceRatio * 100)}% vs baseline).`;

        return {
            tokenDelta,
            tokenDivergenceRatio,
            baselineTokens,
            currentTokens,
            addedKeys,
            removedKeys,
            deviatingFields,
            isBloated,
            recommendation
        };
    }
}

export const globalTokenWeightProfiler = new TokenWeightProfiler();

export interface PreFilterOptions {
    maxMatches?: number;
    minLiquidityVolume?: number;
    stripStaleOdds?: boolean;
    stripVerboseFields?: boolean;
    salientKeys?: string[];
    allowedMarketTypes?: string[];
    dropClosedMatches?: boolean;
}

export interface PreFilterResult {
    filteredData: any;
    originalByteSize: number;
    filteredByteSize: number;
    originalEstimatedTokens: number;
    filteredEstimatedTokens: number;
    tokensSaved: number;
    prunedFieldsCount: number;
    prunedRecordsCount: number;
    reductionRatio: number;
}

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

        const salientSet = new Set(options.salientKeys || DomainPreFilter.DEFAULT_SALIENT_KEYS);
        const stripVerbose = options.stripVerboseFields !== false;
        const stripStale = options.stripStaleOdds !== false;
        const maxMatches = options.maxMatches ?? 50;

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

export interface PartialPrediction {
    id?: string;
    event?: string;
    market?: string;
    predictedOutcome?: string;
    probability?: number;
    confidence?: number;
    odds?: number;
    spread?: number;
    tier?: 'tier1_approx' | 'tier2_refined';
    alternatives?: Array<{ outcome: string; probability: number }>;
    summary?: string;
}

export interface EarlyExitOptions {
    confidenceThreshold?: number; // default: 0.85
    marginThreshold?: number;     // default: 0.35
    requireDecisiveSpread?: boolean;
}

export interface EarlyExitDecision {
    canEarlyExit: boolean;
    confidence: number;
    margin?: number;
    reason: string;
    tier: 'tier1_approx' | 'tier2_refined';
    bypassedRefinement: boolean;
    estimatedLatencySavedMs: number;
}

/**
 * Confidence Early-Exit Evaluator: Assesses Tier 1 fast predictions.
 * When confidence is definitive or outcome margin is decisive, bypasses heavy Tier 2 passes,
 * eliminating 60-120s of unnecessary inference latency.
 */
export class ConfidenceEarlyExitEvaluator {
    private defaultConfidenceThreshold: number;
    private defaultMarginThreshold: number;

    constructor(options: { defaultConfidenceThreshold?: number; defaultMarginThreshold?: number } = {}) {
        this.defaultConfidenceThreshold = options.defaultConfidenceThreshold ?? 0.85;
        this.defaultMarginThreshold = options.defaultMarginThreshold ?? 0.35;
    }

    public evaluate(prediction: PartialPrediction, options: EarlyExitOptions = {}): EarlyExitDecision {
        const confThreshold = options.confidenceThreshold ?? this.defaultConfidenceThreshold;
        const marginThreshold = options.marginThreshold ?? this.defaultMarginThreshold;

        const confidence = prediction.confidence ?? prediction.probability ?? 0.5;

        // Calculate margin if alternatives are provided
        let margin: number | undefined;
        if (prediction.alternatives && prediction.alternatives.length > 0) {
            const sorted = [...prediction.alternatives].sort((a, b) => b.probability - a.probability);
            if (sorted.length >= 2) {
                margin = Math.abs(sorted[0].probability - sorted[1].probability);
            }
        }

        // Rule 1: High Confidence Consensus
        if (confidence >= confThreshold) {
            return {
                canEarlyExit: true,
                confidence,
                margin,
                reason: `Confidence score (${Math.round(confidence * 100)}%) meets or exceeds early-exit threshold (${Math.round(confThreshold * 100)}%).`,
                tier: 'tier1_approx',
                bypassedRefinement: true,
                estimatedLatencySavedMs: 75000 // Estimated 75s saved by skipping Tier 2
            };
        }

        // Rule 2: Decisive Probability Margin
        if (margin !== undefined && margin >= marginThreshold) {
            return {
                canEarlyExit: true,
                confidence,
                margin,
                reason: `Decisive outcome margin (${Math.round(margin * 100)}% gap) exceeds threshold (${Math.round(marginThreshold * 100)}%).`,
                tier: 'tier1_approx',
                bypassedRefinement: true,
                estimatedLatencySavedMs: 75000
            };
        }

        // Uncertainty detected -> Proceed to Tier 2 refinement
        return {
            canEarlyExit: false,
            confidence,
            margin,
            reason: `Confidence (${Math.round(confidence * 100)}%) below threshold (${Math.round(confThreshold * 100)}%); Tier 2 refinement required.`,
            tier: 'tier2_refined',
            bypassedRefinement: false,
            estimatedLatencySavedMs: 0
        };
    }
}

export const globalConfidenceEarlyExitEvaluator = new ConfidenceEarlyExitEvaluator();

export type PredictionTaskPriority = 'high' | 'normal' | 'low';

export interface PoolTask<T = any> {
    id: string;
    priority: PredictionTaskPriority;
    execute: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: any) => void;
    timeoutMs?: number;
    submittedAt: number;
}

export interface WorkerPoolMetrics {
    maxConcurrency: number;
    activeWorkers: number;
    queueLength: number;
    completedTasks: number;
    failedTasks: number;
    totalExecutionTimeMs: number;
    averageTaskDurationMs: number;
}

export interface PredictionWorkerPoolConfig {
    maxConcurrency?: number;
    defaultTaskTimeoutMs?: number;
}

/**
 * Prediction Worker Pool: Parallelizes independent prediction tasks across concurrent lanes.
 * Prevents execution stalls and scales throughput across available compute.
 */
export class PredictionWorkerPool {
    private maxConcurrency: number;
    private defaultTaskTimeoutMs: number;
    private queue: PoolTask[] = [];
    private activeWorkers: number = 0;
    private completedTasks: number = 0;
    private failedTasks: number = 0;
    private totalExecutionTimeMs: number = 0;
    private isShutdown: boolean = false;

    constructor(config: PredictionWorkerPoolConfig = {}) {
        this.maxConcurrency = config.maxConcurrency ?? 4;
        this.defaultTaskTimeoutMs = config.defaultTaskTimeoutMs ?? 30000;
    }

    public submit<T = any>(
        taskFn: () => Promise<T>,
        options: { id?: string; priority?: PredictionTaskPriority; timeoutMs?: number } = {}
    ): Promise<T> {
        if (this.isShutdown) {
            return Promise.reject(new Error('PredictionWorkerPool is shut down'));
        }

        return new Promise<T>((resolve, reject) => {
            const task: PoolTask<T> = {
                id: options.id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                priority: options.priority || 'normal',
                execute: taskFn,
                resolve,
                reject,
                timeoutMs: options.timeoutMs ?? this.defaultTaskTimeoutMs,
                submittedAt: Date.now()
            };

            if (task.priority === 'high') {
                const firstNonHighIdx = this.queue.findIndex(t => t.priority !== 'high');
                if (firstNonHighIdx === -1) {
                    this.queue.push(task);
                } else {
                    this.queue.splice(firstNonHighIdx, 0, task);
                }
            } else if (task.priority === 'low') {
                this.queue.push(task);
            } else {
                const firstLowIdx = this.queue.findIndex(t => t.priority === 'low');
                if (firstLowIdx === -1) {
                    this.queue.push(task);
                } else {
                    this.queue.splice(firstLowIdx, 0, task);
                }
            }

            this.drainQueue();
        });
    }

    public async submitBatch<T = any>(
        taskFns: Array<() => Promise<T>>,
        options: { priority?: PredictionTaskPriority; timeoutMs?: number } = {}
    ): Promise<T[]> {
        return Promise.all(taskFns.map((fn, idx) => this.submit(fn, { ...options, id: `batch-${idx}-${Date.now()}` })));
    }

    private drainQueue(): void {
        while (this.activeWorkers < this.maxConcurrency && this.queue.length > 0) {
            const task = this.queue.shift();
            if (!task) break;

            this.activeWorkers++;
            this.runTask(task);
        }
    }

    private async runTask(task: PoolTask): Promise<void> {
        const startTime = Date.now();
        let timer: any = null;

        const timeoutPromise = new Promise((_, reject) => {
            if (task.timeoutMs && task.timeoutMs > 0) {
                timer = setTimeout(() => {
                    reject(new Error(`[TIMEOUT] PredictionWorkerPool task '${task.id}' timed out after ${task.timeoutMs}ms`));
                }, task.timeoutMs);
            }
        });

        try {
            const result = await Promise.race([task.execute(), timeoutPromise]);
            if (timer) clearTimeout(timer);
            const duration = Date.now() - startTime;
            this.completedTasks++;
            this.totalExecutionTimeMs += duration;
            task.resolve(result);
        } catch (err: any) {
            if (timer) clearTimeout(timer);
            this.failedTasks++;
            task.reject(err);
        } finally {
            this.activeWorkers--;
            this.drainQueue();
        }
    }

    public getStats(): WorkerPoolMetrics {
        return {
            maxConcurrency: this.maxConcurrency,
            activeWorkers: this.activeWorkers,
            queueLength: this.queue.length,
            completedTasks: this.completedTasks,
            failedTasks: this.failedTasks,
            totalExecutionTimeMs: this.totalExecutionTimeMs,
            averageTaskDurationMs: this.completedTasks > 0 ? Math.round(this.totalExecutionTimeMs / this.completedTasks) : 0
        };
    }

    public shutdown(): void {
        this.isShutdown = true;
        while (this.queue.length > 0) {
            const task = this.queue.shift();
            task?.reject(new Error('PredictionWorkerPool has been shut down'));
        }
    }
}

export const globalPredictionWorkerPool = new PredictionWorkerPool();

export interface TieredPredictionInput {
    task: string;
    data?: any;
    baseline?: any;
    onPartialResult?: (partial: PartialPrediction) => void;
    tier1Fn: (data: any) => Promise<PartialPrediction>;
    tier2Fn?: (data: any, tier1Result: PartialPrediction) => Promise<any>;
    options?: {
        enableEarlyExit?: boolean;
        confidenceThreshold?: number;
        marginThreshold?: number;
        preFilter?: boolean;
        subComputationDomain?: SubComputationDomain;
        subComputationKey?: string;
    };
}

export interface TieredPredictionResult {
    finalResult: any;
    tier: 'tier1_approx' | 'tier2_refined';
    earlyExit: boolean;
    earlyExitDecision?: EarlyExitDecision;
    tier1LatencyMs: number;
    tier2LatencyMs: number;
    totalLatencyMs: number;
    partialResultEmitted: boolean;
    tokenReport?: TokenWeightReport;
    preFilterResult?: PreFilterResult;
    cacheHit?: boolean;
}

/**
 * Tiered Prediction Engine: Combines Tier 1 fast approximation (<30s) with
 * Tier 2 accurate refinement (<60s) and early partial streaming.
 */
export class TieredPredictionEngine {
    private cache: DomainSubComputationCache;
    private profiler: TokenWeightProfiler;
    private preFilter: DomainPreFilter;
    private earlyExitEvaluator: ConfidenceEarlyExitEvaluator;
    private workerPool: PredictionWorkerPool;

    constructor(options: {
        cache?: DomainSubComputationCache;
        profiler?: TokenWeightProfiler;
        preFilter?: DomainPreFilter;
        earlyExitEvaluator?: ConfidenceEarlyExitEvaluator;
        workerPool?: PredictionWorkerPool;
    } = {}) {
        this.cache = options.cache || globalDomainSubComputationCache;
        this.profiler = options.profiler || globalTokenWeightProfiler;
        this.preFilter = options.preFilter || globalDomainPreFilter;
        this.earlyExitEvaluator = options.earlyExitEvaluator || globalConfidenceEarlyExitEvaluator;
        this.workerPool = options.workerPool || globalPredictionWorkerPool;
    }

    public async execute(input: TieredPredictionInput): Promise<TieredPredictionResult> {
        const overallStart = Date.now();
        let effectiveData = input.data;
        let preFilterResult: PreFilterResult | undefined;

        // 1. Pre-filter if enabled (default true)
        if (input.options?.preFilter !== false && effectiveData) {
            preFilterResult = this.preFilter.filter(effectiveData);
            effectiveData = preFilterResult.filteredData;
        }

        // 2. Token weight profiling
        const tokenReport = effectiveData ? this.profiler.profile(effectiveData, input.baseline) : undefined;

        // 3. Sub-computation cache check
        if (input.options?.subComputationDomain && input.options?.subComputationKey) {
            const cached = this.cache.get(input.options.subComputationDomain, input.options.subComputationKey);
            if (cached) {
                const totalLatencyMs = Date.now() - overallStart;
                if (input.onPartialResult) {
                    input.onPartialResult(cached);
                }
                return {
                    finalResult: cached,
                    tier: 'tier1_approx',
                    earlyExit: true,
                    tier1LatencyMs: 0,
                    tier2LatencyMs: 0,
                    totalLatencyMs,
                    partialResultEmitted: Boolean(input.onPartialResult),
                    cacheHit: true,
                    tokenReport,
                    preFilterResult
                };
            }
        }

        // 4. Tier 1: Fast approximation (target: sub-30s)
        const t1Start = Date.now();
        const tier1Prediction: PartialPrediction = await this.workerPool.submit(
            () => input.tier1Fn(effectiveData),
            { id: `t1-${Date.now()}`, priority: 'high' }
        );
        tier1Prediction.tier = 'tier1_approx';
        const tier1LatencyMs = Date.now() - t1Start;

        // Emit early partial streaming result immediately!
        let partialResultEmitted = false;
        if (input.onPartialResult) {
            input.onPartialResult(tier1Prediction);
            partialResultEmitted = true;
        }

        // 5. Evaluate confidence early-exit
        const earlyExitDecision = this.earlyExitEvaluator.evaluate(tier1Prediction, {
            confidenceThreshold: input.options?.confidenceThreshold,
            marginThreshold: input.options?.marginThreshold
        });

        const shouldEarlyExit = (input.options?.enableEarlyExit !== false) && earlyExitDecision.canEarlyExit;

        // Cache Tier 1 result if configured
        if (input.options?.subComputationDomain && input.options?.subComputationKey) {
            this.cache.set(input.options.subComputationDomain, input.options.subComputationKey, tier1Prediction);
        }

        if (shouldEarlyExit || !input.tier2Fn) {
            const totalLatencyMs = Date.now() - overallStart;
            return {
                finalResult: tier1Prediction,
                tier: 'tier1_approx',
                earlyExit: shouldEarlyExit,
                earlyExitDecision,
                tier1LatencyMs,
                tier2LatencyMs: 0,
                totalLatencyMs,
                partialResultEmitted,
                tokenReport,
                preFilterResult,
                cacheHit: false
            };
        }

        // 6. Tier 2: Accurate refinement (target: sub-60s)
        const t2Start = Date.now();
        const refinedResult = await this.workerPool.submit(
            () => input.tier2Fn!(effectiveData, tier1Prediction),
            { id: `t2-${Date.now()}`, priority: 'normal' }
        );
        const tier2LatencyMs = Date.now() - t2Start;
        const totalLatencyMs = Date.now() - overallStart;

        if (input.options?.subComputationDomain && input.options?.subComputationKey) {
            this.cache.set(input.options.subComputationDomain, input.options.subComputationKey, refinedResult);
        }

        return {
            finalResult: refinedResult,
            tier: 'tier2_refined',
            earlyExit: false,
            earlyExitDecision,
            tier1LatencyMs,
            tier2LatencyMs,
            totalLatencyMs,
            partialResultEmitted,
            tokenReport,
            preFilterResult,
            cacheHit: false
        };
    }
}

export const globalTieredPredictionEngine = new TieredPredictionEngine();
