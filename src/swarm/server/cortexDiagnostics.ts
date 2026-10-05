import type { MemoryCortex } from '../memory.ts';
import { globalBenchmarker } from '../benchmark.ts';
import { globalTelemetryCollector } from '../telemetry.ts';

/**
 * Builds enhanced diagnostic report with role recommendations and benchmark data.
 */
export async function buildCortexDiagnostics(cortex: MemoryCortex, appId?: string): Promise<any> {
    const diagnostics = await cortex.getDiagnostics(appId);

    // Generate structured role recommendations based on app's actual roles and benchmarks
    const bestModels = globalBenchmarker.getBestModels();
    const telemetry = globalTelemetryCollector.getSnapshot();

    diagnostics.latencyStats = telemetry.modelMs;
    diagnostics.cacheHitRatio = telemetry.cacheHitRatio;
    diagnostics.roleRecommendations = [];

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
