import {
    checkTieredCacheLookup,
    checkSemanticCacheMatch
} from "../cachingPipeline.ts";
import { globalTieredCache } from '../../tieredCache.ts';
import { globalFeedbackEngine } from '../../feedback.ts';
import { globalKnowledgeGraph } from '../../knowledgeGraph.ts';
import { globalHypothesisLayer, globalLearningRateManager } from '../../coordination.ts';
import { globalMetricsCollector, globalUnifiedProfiler } from '../../profiler.ts';
import { PayloadCache, globalPayloadCache } from '../../cache.ts';
import type { SwarmFeedbackReport } from "../types.ts";

export async function processTieredCache(
    cacheQuery: string,
    task: string,
    data: string,
    context: any,
    targetAppId: string,
    workflowStartTime: number,
    settings: any,
    paramsOnStage: any
): Promise<any | null> {
    const lookup = checkTieredCacheLookup({
        query: cacheQuery,
        task,
        similarityThreshold: settings?.tieredCacheSettings?.l2SimilarityThreshold,
        context
    });
    if (lookup.found && lookup.value) {
        paramsOnStage?.({ stage: 'completed', task });
        const workflowDurationMs = Date.now() - workflowStartTime;
        globalMetricsCollector.recordTaskExecution({ success: true, durationMs: workflowDurationMs, agentRole: 'Tiered Cache Engine' });
        const metrics = globalMetricsCollector.getBaselineReport();
        const profilingEnabled = settings?.profilingSettings?.enabled !== false;
        if (profilingEnabled) {
            globalUnifiedProfiler.recordWorkflowRun({
                durationMs: workflowDurationMs,
                cache: { l1Hits: lookup.tier === 'L1' ? 1 : 0, l2Hits: lookup.tier === 'L2' ? 1 : 0, l3Hits: lookup.tier === 'L3' ? 1 : 0, savedTokens: 250 }
            });
        }
        const feedbackEnabled = settings?.feedbackSettings?.enabled !== false;
        let cacheHitFeedbackReport: SwarmFeedbackReport | undefined;
        if (feedbackEnabled) {
            try {
                const fbResult = await globalFeedbackEngine.processFeedback({
                    workflowId: (context as any).id || `wf-${Date.now()}`,
                    task, appId: targetAppId, durationMs: workflowDurationMs,
                    targetTier: 'instant', tokenSavings: 250, tokensConsumed: 0,
                    qualityScore: 0.95, accuracyScore: 0.99, errorCount: 0,
                    finalInsightSnippet: typeof lookup.value === 'string' ? lookup.value.slice(0, 150) : (lookup.value?.ui_title || 'Tiered Cache Hit'),
                    inputData: data
                });
                cacheHitFeedbackReport = {
                    reward: fbResult.reward, tunedParameters: fbResult.tunedParameters,
                    driftAlerts: fbResult.driftAlerts, outcomeId: fbResult.outcomeId, policyUpdated: fbResult.policyUpdated
                };
            } catch (fbErr: any) {
                console.warn('[TieredCache] Feedback processing failed:', fbErr);
            }
        }
        return {
            workflowId: (context as any).id, events: context.events, finalAnalysis: lookup.value,
            metrics, tieredCache: { hit: true, tier: lookup.tier, similarity: lookup.similarity, latencyMs: lookup.latencyMs, metrics: globalTieredCache.getMetrics() },
            unifiedBaselines: profilingEnabled ? globalUnifiedProfiler.getUnifiedBaselineReport() : undefined,
            feedback: cacheHitFeedbackReport,
            coordination: {
                knowledgeGraphVersion: globalKnowledgeGraph.getVersion(), totalNodes: globalKnowledgeGraph.getStats().totalNodes,
                totalEdges: globalKnowledgeGraph.getStats().totalEdges, hypothesesCount: globalHypothesisLayer.getHypotheses().length,
                validatedHypothesesCount: globalHypothesisLayer.getHypotheses('validated').length,
                agentLearningRates: Object.fromEntries(globalLearningRateManager.getAllStates().map(s => [s.agentId, s.learningRate]))
            }
        };
    }
    return null;
}
