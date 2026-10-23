import type { MemoryCortex } from '../memory.ts';
import { globalBenchmarker } from '../benchmark.ts';
import { globalTelemetryCollector } from '../telemetry.ts';
import { analystLedger } from '../feedback.ts';
import { fitCalibration, observationsForApp } from '../feedback/probabilityCalibration.ts';
import { globalSpecialistProfiler } from '../loadBalancer.ts';
import { getSupabaseConfig } from '../morning/supabase.ts';

/**
 * Builds enhanced diagnostic report with role recommendations, benchmark data,
 * and closed-loop learning & calibration telemetry across Qdrant and Supabase.
 */
export async function buildCortexDiagnostics(cortex: MemoryCortex, appId?: string): Promise<any> {
    const diagnostics: any = await cortex.getDiagnostics(appId);

    // Generate structured role recommendations based on app's actual roles and benchmarks
    const bestModels = globalBenchmarker.getBestModels();
    const telemetry = globalTelemetryCollector.getSnapshot();

    diagnostics.latencyStats = telemetry.modelMs;
    diagnostics.cacheHitRatio = telemetry.cacheHitRatio;
    diagnostics.roleRecommendations = [];

    // Closed-Loop Learning & Calibration Telemetry
    const targetCalibrationApp = appId && appId !== 'global' ? appId : 'duelodds';
    const calObservations = observationsForApp(targetCalibrationApp);
    const calibrationFit = fitCalibration(calObservations);
    const ledgerMetrics = analystLedger.getMetrics();
    const specialistProfiles = globalSpecialistProfiler.getAllProfiles();

    const seatAccuracy: Array<{
        appId: string;
        role: string;
        wins: number;
        losses: number;
        pushes: number;
        total: number;
        winRate: number;
        ucb1Score: number;
        capabilityScore: number;
    }> = [];

    for (const [key, rec] of Object.entries(ledgerMetrics)) {
        const sepIdx = key.indexOf(':');
        const entryApp = sepIdx >= 0 ? key.slice(0, sepIdx) : 'global';
        const role = sepIdx >= 0 ? key.slice(sepIdx + 1) : key;
        if (appId && appId !== 'global' && entryApp !== appId) continue;
        const total = (rec.wins || 0) + (rec.losses || 0) + (rec.pushes || 0);
        const winRate = total > 0 ? Math.round((((rec.wins || 0) + 0.5 * (rec.pushes || 0)) / total) * 1000) / 1000 : 0.5;
        seatAccuracy.push({
            appId: entryApp,
            role,
            wins: rec.wins || 0,
            losses: rec.losses || 0,
            pushes: rec.pushes || 0,
            total,
            winRate,
            ucb1Score: globalSpecialistProfiler.getUcb1Score(role),
            capabilityScore: globalSpecialistProfiler.getCapabilityScore(role)
        });
    }

    // Also include profiled seats that may not be in ledgerMetrics yet
    for (const [role, prof] of Object.entries(specialistProfiles)) {
        if (seatAccuracy.some(s => s.role === role)) continue;
        const total = (prof.accuracyWins || 0) + (prof.accuracyLosses || 0) + (prof.accuracyPushes || 0);
        if (total === 0 && (prof.trials || 0) === 0) continue;
        seatAccuracy.push({
            appId: targetCalibrationApp,
            role,
            wins: prof.accuracyWins || 0,
            losses: prof.accuracyLosses || 0,
            pushes: prof.accuracyPushes || 0,
            total,
            winRate: prof.accuracyScore ?? 0.5,
            ucb1Score: globalSpecialistProfiler.getUcb1Score(role),
            capabilityScore: globalSpecialistProfiler.getCapabilityScore(role)
        });
    }

    seatAccuracy.sort((a, b) => b.total - a.total || b.winRate - a.winRate);

    diagnostics.learningTelemetry = {
        supabaseConfigured: Boolean(getSupabaseConfig()),
        calibrationAppId: targetCalibrationApp,
        calibration: calibrationFit,
        seatAccuracy
    };

    if (bestModels && Object.keys(diagnostics.storageByRole).length > 0) {
        for (const role of Object.keys(diagnostics.storageByRole)) {
            const roleLower = role.toLowerCase();

            if (roleLower.includes('router') || roleLower.includes('classif')) {
                if (bestModels.bestRouter) {
                    diagnostics.roleRecommendations.push({
                        role,
                        recommendedProvider: bestModels.bestRouter.provider,
                        recommendedModel: bestModels.bestRouter.modelName,
                        reason: `Fastest routing performance (${bestModels.bestRouter.routingLatency}ms). Ideal for high-volume classifier roles.`
                    });
                }
            } else if (roleLower.includes('manager') || roleLower.includes('critic') || roleLower.includes('synthesiz') || roleLower.includes('review')) {
                if (bestModels.bestReasoning) {
                    diagnostics.roleRecommendations.push({
                        role,
                        recommendedProvider: bestModels.bestReasoning.provider,
                        recommendedModel: bestModels.bestReasoning.modelName,
                        reason: `High reasoning capability (passed logic tests). Critical for synthesis and verification roles.`
                    });
                }
            } else {
                // General Analyst/Worker role
                if (bestModels.bestRouter) {
                    diagnostics.roleRecommendations.push({
                        role,
                        recommendedProvider: bestModels.bestRouter.provider,
                        recommendedModel: bestModels.bestRouter.modelName,
                        reason: `Excellent balance of speed and efficiency. Suitable for general extraction and analysis tasks.`
                    });
                }
            }
        }
    }

    // Fallback backward-compatible model suggestions HTML
    if (bestModels) {
        let suggestionsHtml = '<ul class="space-y-1.5 list-disc list-inside">\n';
        if (bestModels.bestRouter) {
            suggestionsHtml += `<li><strong>Speed & Cost:</strong> ${bestModels.bestRouter.provider} (${bestModels.bestRouter.modelName}) is currently fastest at ${bestModels.bestRouter.routingLatency}ms.</li>\n`;
        }
        if (bestModels.bestReasoning) {
            suggestionsHtml += `<li><strong>Deep Reasoning:</strong> ${bestModels.bestReasoning.provider} (${bestModels.bestReasoning.modelName}) passed logic tests in ${bestModels.bestReasoning.reasoningLatency}ms.</li>\n`;
        }
        suggestionsHtml += `<li><strong>Current Cache Hit Ratio:</strong> ${diagnostics.cacheHitRatio !== undefined ? `${(diagnostics.cacheHitRatio * 100).toFixed(1)}%` : 'N/A'}. A higher ratio speeds up analysis and lowers cost.</li>\n`;
        suggestionsHtml += `<li><strong>Throughput:</strong> p95 latency is ${diagnostics.latencyStats?.p95 !== undefined ? `${diagnostics.latencyStats.p95}ms` : 'N/A'}, p99 is ${diagnostics.latencyStats?.p99 !== undefined ? `${diagnostics.latencyStats.p99}ms` : 'N/A'}.</li>\n`;
        suggestionsHtml += '</ul>';
        diagnostics.modelSuggestions = suggestionsHtml;
    }

    return diagnostics;
}

