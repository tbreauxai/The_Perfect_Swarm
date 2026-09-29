import { SubComputationCacheEntry, SubComputationCacheMetrics, SubComputationCacheConfig, BaselineDifference, TokenWeightReport, PreFilterOptions, PreFilterResult, PartialPrediction, EarlyExitOptions, EarlyExitDecision, PoolTask, WorkerPoolMetrics, PredictionWorkerPoolConfig, TieredPredictionInput, TieredPredictionResult, SubComputationDomain, PredictionTaskPriority } from "./types.ts";
import { DomainSubComputationCache } from "./DomainSubComputationCache.ts";
import { TokenWeightProfiler } from "./TokenWeightProfiler.ts";
import { DomainPreFilter } from "./DomainPreFilter.ts";
import { ConfidenceEarlyExitEvaluator } from "./ConfidenceEarlyExitEvaluator.ts";
import { PredictionWorkerPool } from "./PredictionWorkerPool.ts";
import { TieredPredictionEngine } from "./TieredPredictionEngine.ts";

export const globalDomainSubComputationCache = new DomainSubComputationCache();
export const globalTokenWeightProfiler = new TokenWeightProfiler();
export const globalDomainPreFilter = new DomainPreFilter();
export const globalConfidenceEarlyExitEvaluator = new ConfidenceEarlyExitEvaluator();
export const globalPredictionWorkerPool = new PredictionWorkerPool();
export const globalTieredPredictionEngine = new TieredPredictionEngine();
