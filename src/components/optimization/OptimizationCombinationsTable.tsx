import React from 'react';
import { Trophy, Clock, CheckCircle, AlertCircle, Play, Loader2 } from 'lucide-react';
import type { OptimizationResult } from './OptimizationRunner';
import { isModelResponseValid } from './optimizationScoring';

export interface OptimizationCombinationsTableProps {
    results: OptimizationResult[];
    winningCombo: OptimizationResult | null;
    isRunning: boolean;
    onRunCombinations: () => void;
    onApplyWinningCombo: (combo: OptimizationResult) => void;
}

export const OptimizationCombinationsTable: React.FC<OptimizationCombinationsTableProps> = ({
    results,
    winningCombo,
    isRunning,
    onRunCombinations,
    onApplyWinningCombo
}) => {
    const fullSwarmResults = results.filter(r => r.isFullSwarm);

    return (
        <div className="mt-8 pt-8 border-t border-neutral-200">
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h4 className="text-lg font-semibold text-neutral-800 flex items-center gap-2">
                        <Trophy className="w-5 h-5 text-indigo-600" />
                        Full Swarm Combinations
                    </h4>
                    <p className="text-sm text-neutral-500 mt-1">Tests combinations of the highest scoring error-free models.</p>
                </div>

                <div className="flex items-center gap-2">
                    {winningCombo && (
                        <button
                            onClick={() => onApplyWinningCombo(winningCombo)}
                            disabled={isRunning}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium py-2 px-4 rounded-lg transition-colors flex items-center gap-2 shadow-sm text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                            title={`Apply full winning configuration: ${winningCombo.model}`}
                        >
                            <CheckCircle className="w-4 h-4" />
                            Apply Best Configuration
                        </button>
                    )}
                    <button
                        onClick={onRunCombinations}
                        disabled={isRunning}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-4 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                    >
                        {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                        Test Combinations
                    </button>
                </div>
            </div>

            {fullSwarmResults.length > 0 && (
                <div className="mt-4">
                    <div className="bg-white rounded-xl border border-neutral-200 shadow-sm overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm whitespace-nowrap">
                                <thead className="uppercase tracking-wider border-b-2 border-neutral-200 bg-neutral-50 text-neutral-500 text-[10px] font-semibold">
                                    <tr>
                                        <th className="px-4 py-3">Combination</th>
                                        <th className="px-4 py-3">Time</th>
                                        <th className="px-4 py-3">Speed Score</th>
                                        <th className="px-4 py-3">Intelligence</th>
                                        <th className="px-4 py-3">Accuracy</th>
                                        <th className="px-4 py-3">Output Snippet</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-neutral-200 text-neutral-800">
                                    {fullSwarmResults.map(r => (
                                        <tr key={r.id} className="hover:bg-neutral-50">
                                            <td className="px-4 py-3 font-mono text-xs max-w-[200px] truncate" title={r.model}>
                                                {r.model}
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${r.durationMs < 3000 ? 'bg-green-100 text-green-700' : r.durationMs < 8000 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                                                    <Clock className="w-3 h-3" />
                                                    {(r.durationMs / 1000).toFixed(1)}s
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 font-semibold text-purple-700">{r.scores.speed || '-'}</td>
                                            <td className="px-4 py-3 font-semibold text-blue-700">{r.scores.intelligence || '-'}</td>
                                            <td className="px-4 py-3 font-semibold text-emerald-700">{r.scores.accuracy || '-'}</td>
                                            <td className="px-4 py-3 max-w-xs truncate text-xs text-neutral-600 font-mono">
                                                {r.error ? (
                                                    <span className="text-red-500 flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {r.error}</span>
                                                ) : !isModelResponseValid(r) ? (
                                                    <span className="text-amber-500 flex items-center gap-1"><AlertCircle className="w-3 h-3" /> Incomplete output</span>
                                                ) : typeof r.output === 'object' ? (
                                                    JSON.stringify(r.output)
                                                ) : (
                                                    String(r.output || 'No output')
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
