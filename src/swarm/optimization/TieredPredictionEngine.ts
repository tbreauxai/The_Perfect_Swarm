import { SubComputationCacheEntry, SubComputationCacheMetrics, SubComputationCacheConfig, BaselineDifference, TokenWeightReport, PreFilterOptions, PreFilterResult, PartialPrediction, EarlyExitOptions, EarlyExitDecision, PoolTask, WorkerPoolMetrics, PredictionWorkerPoolConfig, TieredPredictionInput, TieredPredictionResult, SubComputationDomain, PredictionTaskPriority } from "./types.ts";
import { globalDomainSubComputationCache, globalTokenWeightProfiler, globalDomainPreFilter, globalConfidenceEarlyExitEvaluator, globalPredictionWorkerPool } from "./globals.ts";
import { DomainSubComputationCache } from "./DomainSubComputationCache.ts";
import { TokenWeightProfiler } from "./TokenWeightProfiler.ts";
import { DomainPreFilter } from "./DomainPreFilter.ts";
import { ConfidenceEarlyExitEvaluator } from "./ConfidenceEarlyExitEvaluator.ts";
import { PredictionWorkerPool } from "./PredictionWorkerPool.ts";

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
        if (input.options?.preFilter !== false && effectiveData) {
            preFilterResult = this.preFilter.filter(effectiveData);
            effectiveData = preFilterResult.filteredData;
        }

        const tokenReport = effectiveData ? this.profiler.profile(effectiveData, input.baseline) : undefined;
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

        const t1Start = Date.now();
        const tier1Prediction: PartialPrediction = await this.workerPool.submit(
                        () => input.tier1Fn(effectiveData),
                        { id: `t1-${Date.now()}`, priority: 'high' }
                    );
        tier1Prediction.tier = 'tier1_approx';
        const tier1LatencyMs = Date.now() - t1Start;
        let partialResultEmitted = false;
        if (input.onPartialResult) {
            input.onPartialResult(tier1Prediction);
            partialResultEmitted = true;
        }

        const earlyExitDecision = this.earlyExitEvaluator.evaluate(tier1Prediction, {
                        confidenceThreshold: input.options?.confidenceThreshold,
                        marginThreshold: input.options?.marginThreshold
                    });
        const shouldEarlyExit = (input.options?.enableEarlyExit !== false) && earlyExitDecision.canEarlyExit;
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
