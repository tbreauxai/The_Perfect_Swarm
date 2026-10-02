import type { SwarmContext } from '../context.ts';
import type { SwarmWorkflowParams } from './types.ts';
import type { SwarmEngineSettings } from '../types.ts';
import {
    globalConfidenceEarlyExitEvaluator,
    type PartialPrediction
} from '../optimization.ts';

export interface EarlyExitEvaluationResult {
    earlyPartialPrediction?: PartialPrediction;
    earlyExitTriggered: boolean;
    earlyExitLatencySavedMs: number;
    earlyFinalAnalysis: any | null;
}

export function evaluateEarlyExit(params: {
    task: string;
    allAnalystReports: any[][];
    analystsCount: number;
    optimizationEnabled: boolean;
    settings?: SwarmEngineSettings;
    context: SwarmContext;
    workflowParams: SwarmWorkflowParams;
}): EarlyExitEvaluationResult {
    const {
        task,
        allAnalystReports,
        analystsCount,
        optimizationEnabled,
        settings,
        context,
        workflowParams
    } = params;

    let earlyPartialPrediction: PartialPrediction | undefined;
    let earlyExitTriggered = false;
    let earlyExitLatencySavedMs = 0;
    let earlyFinalAnalysis: any | null = null;
    const optSettings = settings?.optimizationSettings;

    if (optimizationEnabled && analystsCount > 0) {
        const allFlatReports = allAnalystReports.flat().filter(Boolean);
        if (allFlatReports.length > 0) {
            const combinedInsights: string[] = [];
            const combinedAnomalies: string[] = [];
            for (const r of allFlatReports) {
                if (Array.isArray(r.insights)) combinedInsights.push(...r.insights);
                if (Array.isArray(r.anomalies)) combinedAnomalies.push(...r.anomalies);
            }

            const firstRep = allFlatReports[0];
            let parsedConfidence = 0.82;
            const summaryText = firstRep.summary || '';
            const confMatch = summaryText.match(/confidence:?\s*(\d+(?:\.\d+)?)/i);
            if (confMatch) {
                const num = parseFloat(confMatch[1]);
                parsedConfidence = num > 1 ? num / 100 : num;
            }

            earlyPartialPrediction = {
                id: `partial-${Date.now()}`,
                event: task,
                market: 'primary_prediction',
                predictedOutcome: firstRep.summary || combinedInsights[0] || 'Early partial analysis complete',
                confidence: parsedConfidence,
                probability: parsedConfidence,
                tier: 'tier1_approx',
                summary: firstRep.summary || (combinedInsights.slice(0, 3).join('; ') || 'Specialist preliminary consensus formed')
            };

            workflowParams.onPartialResult?.(earlyPartialPrediction);
            workflowParams.onStage?.({
                stage: 'partial_prediction',
                task,
                partialPrediction: earlyPartialPrediction
            });

            context.addEvent({
                agentRole: 'Tiered Prediction Engine',
                action: 'Early Partial Result Streamed',
                modelName: 'Local/Tier1Inference',
                prompt: `Streamed Tier 1 preliminary prediction (confidence: ${Math.round(parsedConfidence * 100)}%): "${earlyPartialPrediction.summary.slice(0, 80)}"`,
                output: earlyPartialPrediction,
                durationMs: 0
            });

            if (optSettings?.enableEarlyExit) {
                const earlyExitDecision = globalConfidenceEarlyExitEvaluator.evaluate(
                    earlyPartialPrediction,
                    {
                        confidenceThreshold: optSettings.confidenceThreshold ?? 0.85,
                        marginThreshold: optSettings.marginThreshold ?? 0.35
                    }
                );

                if (earlyExitDecision.canEarlyExit) {
                    earlyExitTriggered = true;
                    earlyExitLatencySavedMs = earlyExitDecision.estimatedLatencySavedMs;
                    context.addEvent({
                        agentRole: 'Confidence Early-Exit Evaluator',
                        action: 'Early-Exit Bypass Activated',
                        modelName: 'Local/ConfidenceEvaluator',
                        prompt: `Early-exit triggered: ${earlyExitDecision.reason} (Latency saved: ~${earlyExitDecision.estimatedLatencySavedMs}ms)`,
                        output: earlyExitDecision,
                        durationMs: 0
                    });

                    earlyFinalAnalysis = {
                        ui_title: `Fast Prediction: ${task.substring(0, 40)}`,
                        components: [
                            {
                                id: 'partial-summary',
                                type: 'InsightList',
                                props: {
                                    title: 'Early Prediction Insights (Tier 1 Verified)',
                                    insights: combinedInsights.length > 0
                                        ? combinedInsights.map((i: string) => ({ type: 'info', message: i }))
                                        : [{ type: 'info', message: earlyPartialPrediction.summary }]
                                }
                            }
                        ]
                    };
                }
            }
        }
    }

    return {
        earlyPartialPrediction,
        earlyExitTriggered,
        earlyExitLatencySavedMs,
        earlyFinalAnalysis
    };
}
