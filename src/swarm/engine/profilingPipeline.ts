import { profileData, createTokenChunks, type DataProfile } from '../profiler.ts';
import {
    globalDomainPreFilter,
    globalTokenWeightProfiler,
    type PreFilterResult,
    type TokenWeightReport
} from '../optimization.ts';
import { globalTaskDecomposer, type TaskDecompositionPlan } from '../coordination.ts';
import { SwarmContext } from '../context.ts';
import { Agent } from '../agent.ts';

export interface ProfilingPipelineParams {
    task: string;
    data?: string;
    analysts: Agent[];
    settings?: any;
    optimizationEnabled: boolean;
    coordinationEnabled: boolean;
    context: SwarmContext;
}

export interface ProfilingPipelineResult {
    effectiveDataPayload: string;
    preFilterResult?: PreFilterResult;
    rawInput: string;
    profile: DataProfile;
    tokenWeightReport?: TokenWeightReport;
    workflowDecompositionPlan?: TaskDecompositionPlan;
    chunks: string[];
    originalChunkCount: number;
    maxTokensPerChunk: number;
    totalTokens: number;
    warning?: string;
}

/**
 * Modular data profiling, pre-filtering, token budgeting, and task decomposition pipeline.
 */
export function runDataProfilingPipeline(params: ProfilingPipelineParams): ProfilingPipelineResult {
    const { task, data, analysts, settings, optimizationEnabled, coordinationEnabled, context } = params;
    const optSettings = settings?.optimizationSettings;
    const coordinationSettings = settings?.coordinationSettings;

    // 1. Data Profiling & Domain Pre-Filtering
    let effectiveDataPayload = data || "";
    let preFilterResult: PreFilterResult | undefined;

    if (optimizationEnabled && optSettings?.enablePreFiltering !== false && data) {
        preFilterResult = globalDomainPreFilter.filter(data);
        if (preFilterResult.tokensSaved > 0) {
            effectiveDataPayload = typeof preFilterResult.filteredData === 'string'
                ? preFilterResult.filteredData
                : JSON.stringify(preFilterResult.filteredData);
            context.addEvent({
                agentRole: 'Domain Pre-Filter',
                action: 'Irrelevant Data Pruned',
                modelName: 'Local/DomainPreFilter',
                prompt: `Pruned ${preFilterResult.prunedFieldsCount} noisy fields & ${preFilterResult.prunedRecordsCount} records, saving ~${preFilterResult.tokensSaved} tokens (${Math.round(preFilterResult.reductionRatio * 100)}% reduction)`,
                output: preFilterResult,
                durationMs: 0
            });
        }
    }

    const { rawInput, profile } = profileData(effectiveDataPayload);
    context.addEvent({
        agentRole: 'System Profiler',
        action: 'Metadata Extracted',
        modelName: 'Local/TypeScript',
        prompt: 'Analyzing payload size...',
        output: profile,
        durationMs: 0
    });

    let tokenWeightReport: TokenWeightReport | undefined;
    if (optimizationEnabled) {
        tokenWeightReport = globalTokenWeightProfiler.profile(effectiveDataPayload, (settings as any)?.historicalBaseline);
        context.addEvent({
            agentRole: 'Token Weight Profiler',
            action: 'Metadata Token Weight Profiling',
            modelName: 'Local/TokenWeightProfiler',
            prompt: `Metadata token weight: ${tokenWeightReport.metadataTokens}/${tokenWeightReport.totalTokens} tokens (${Math.round(tokenWeightReport.metadataWeightRatio * 100)}%). Bloated: ${tokenWeightReport.isBloated}`,
            output: tokenWeightReport,
            durationMs: 0
        });
    }

    // 2. Hierarchical Task Decomposition
    let workflowDecompositionPlan: TaskDecompositionPlan | undefined;
    if (coordinationEnabled && coordinationSettings?.hierarchicalDecomposition !== false) {
        const specialistRoles = analysts.map(a => a.role);
        workflowDecompositionPlan = globalTaskDecomposer.decompose(task, specialistRoles);
        context.addEvent({
            agentRole: 'Strategy Coordinator',
            action: 'Hierarchical Task Decomposition',
            modelName: 'Local/HierarchicalTaskDecomposer',
            prompt: `Decomposed macro-task into ${workflowDecompositionPlan.subtasks.length} strategic subtasks across ${workflowDecompositionPlan.executionWaves.length} waves`,
            output: {
                macroTask: workflowDecompositionPlan.macroTask,
                strategySummary: workflowDecompositionPlan.strategySummary,
                subtasksCount: workflowDecompositionPlan.subtasks.length,
                executionWavesCount: workflowDecompositionPlan.executionWaves.length,
                subtasks: workflowDecompositionPlan.subtasks
            },
            durationMs: 0
        });
    }

    // 3. Token Budgeting & Batch Planning
    const { chunks, originalChunkCount, maxTokensPerChunk, totalTokens, warning } = createTokenChunks(rawInput);
    context.addEvent({
        agentRole: 'System Profiler',
        action: 'Token Budgeting',
        modelName: 'Local/TypeScript',
        prompt: `Data exceeds single-pass threshold? ${chunks.length > 1 ? 'Yes' : 'No'}`,
        output: { chunks: chunks.length, originalChunks: originalChunkCount, maxTokensPerChunk, totalTokens, warning },
        durationMs: 0
    });

    return {
        effectiveDataPayload,
        preFilterResult,
        rawInput,
        profile,
        tokenWeightReport,
        workflowDecompositionPlan,
        chunks,
        originalChunkCount,
        maxTokensPerChunk,
        totalTokens,
        warning
    };
}
