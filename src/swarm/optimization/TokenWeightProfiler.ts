import { SubComputationCacheEntry, SubComputationCacheMetrics, SubComputationCacheConfig, BaselineDifference, TokenWeightReport, PreFilterOptions, PreFilterResult, PartialPrediction, EarlyExitOptions, EarlyExitDecision, PoolTask, WorkerPoolMetrics, PredictionWorkerPoolConfig, TieredPredictionInput, TieredPredictionResult, SubComputationDomain, PredictionTaskPriority } from "./types.ts";

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
