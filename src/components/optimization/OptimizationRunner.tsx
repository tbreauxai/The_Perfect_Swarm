import React from 'react';
import { clearAllQuarantinedModels } from '../../services/providerService';
import { Loader2, Ban, Trophy, AlertCircle } from 'lucide-react';
import { OptimizationAgentCard } from './OptimizationAgentCard';
import { OptimizationErrorLog } from './OptimizationErrorLog';
import { OptimizationCombinationsTable } from './OptimizationCombinationsTable';
import { OptimizationHistoryTable } from './OptimizationHistoryTable';
import { useOptimizationRunner } from './useOptimizationRunner';
import type { OptimizationRunnerProps, OptimizationResult } from './types';

export { type OptimizationRunnerProps, type OptimizationResult } from './types';

export {
    type ProviderBackoffState,
    PROVIDER_BACKOFFS,
    getProviderBackoff,
    parseRetryAfterMs,
    calculateBackoffMs,
    recordProvider429,
    recordProviderSuccess,
    ensureTier2Health,
    WORKING_MODELS,
    type GraderCacheEntry,
    GRADER_CACHE_STORAGE_KEY,
    GRADER_CACHE_TTL_MS,
    loadGraderCache,
    saveGraderCache,
    GRADER_CACHE,
    PROMPT_GEN_CACHE_STORAGE_KEY,
    getPromptGenCacheKey,
    loadPromptGenCache,
    savePromptGenCache,
    PROMPT_GEN_CACHE,
    fetchAnalyze,
    getGraderCacheKey
} from './optimizationCaches';

export {
    scoreOf,
    calculateConsensusScore,
    calculateSpeedScore,
    isModelResponseValid,
    type ModelExecutionStatus,
    getModelExecutionStatus,
    extractGradingScores
} from './optimizationScoring';

export const OptimizationRunner: React.FC<OptimizationRunnerProps> = (props) => {
    const { settings } = props;
    const {
        results,
        history,
        setHistory,
        isRunning,
        progress,
        errorRecords,
        promptGenStatus,
        consensusMode,
        setConsensusMode,
        quarantinedCount,
        setQuarantinedCount,
        winningCombo,
        runAgentOptimization,
        runFullSwarmCombinations,
        applyBestToSettings,
        clearErrorRecords
    } = useOptimizationRunner(props);

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-lg font-medium text-neutral-800 flex items-center gap-2">
                        <Trophy className="w-5 h-5 text-amber-500" />
                        Model Optimizer
                    </h3>
                    <p className="text-sm text-neutral-500 mt-1">
                        Tests available models in each analyst role to find the best balance of speed and intelligence.
                    </p>
                    {promptGenStatus && !promptGenStatus.ok && (
                        <div className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 bg-amber-50 text-amber-700 rounded-md border border-amber-200 text-xs">
                            <AlertCircle className="w-3 h-3" />
                            <span><strong>Prompt Generation Failed:</strong> Falling back to base task. ({promptGenStatus.error})</span>
                        </div>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    {quarantinedCount > 0 && (
                        <button
                            onClick={() => {
                                clearAllQuarantinedModels();
                                setQuarantinedCount(0);
                            }}
                            className="flex items-center gap-1.5 text-xs text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 px-2.5 py-1.5 rounded transition-colors"
                            title="Clear all 404 quarantined models"
                        >
                            <Ban className="w-3.5 h-3.5" />
                            <span>Quarantined ({quarantinedCount}) [Clear]</span>
                        </button>
                    )}
                    <label className="flex items-center gap-2 text-xs text-neutral-600 cursor-pointer select-none bg-neutral-50 px-2.5 py-1.5 rounded border border-neutral-200 hover:bg-neutral-100 transition-colors">
                        <input
                            type="checkbox"
                            checked={consensusMode}
                            onChange={(e) => setConsensusMode(e.target.checked)}
                            disabled={isRunning}
                            className="rounded text-indigo-600 focus:ring-indigo-500 h-3.5 w-3.5"
                        />
                        <span className="font-medium">Consensus (3× vote)</span>
                    </label>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {(settings.agents || []).map((agent: any) => (
                    <OptimizationAgentCard
                        key={agent.id}
                        agent={agent}
                        results={results}
                        isRunning={isRunning}
                        onTestAgent={runAgentOptimization}
                    />
                ))}
            </div>

            <OptimizationErrorLog
                errorRecords={errorRecords}
                onClearErrors={clearErrorRecords}
            />

            {isRunning && (
                <div className="bg-indigo-50 border border-indigo-100 p-3 rounded-lg flex items-center gap-3">
                    <Loader2 className="w-5 h-5 text-indigo-600 animate-spin" />
                    <span className="text-sm font-medium text-indigo-800">{progress}</span>
                </div>
            )}

            <OptimizationCombinationsTable
                results={results}
                winningCombo={winningCombo}
                isRunning={isRunning}
                onRunCombinations={runFullSwarmCombinations}
                onApplyWinningCombo={applyBestToSettings}
            />

            <OptimizationHistoryTable
                history={history}
                onClearHistory={() => { localStorage.removeItem('swarm_optimization_history'); setHistory([]); }}
                onApplyToSettings={applyBestToSettings}
            />
        </div>
    );
};
