import React from 'react';
import { Trophy, Clock, Trash2 } from 'lucide-react';
import type { OptimizationResult } from './OptimizationRunner';
import { isModelResponseValid } from './optimizationScoring';

export interface OptimizationHistoryTableProps {
    history: OptimizationResult[];
    onClearHistory: () => void;
    onApplyToSettings: (result: OptimizationResult) => void;
}

export const OptimizationHistoryTable: React.FC<OptimizationHistoryTableProps> = ({
    history,
    onClearHistory,
    onApplyToSettings
}) => {
    if (history.length === 0) return null;

    return (
        <div className="mt-8 pt-8 border-t border-neutral-200">
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h4 className="text-lg font-semibold text-neutral-800 flex items-center gap-2">
                        <Trophy className="w-5 h-5 text-yellow-500" />
                        Local Historical Leaderboard
                    </h4>
                    <p className="text-sm text-neutral-500 mt-1">The highest scoring models from all your past benchmarking sessions.</p>
                </div>
                <button onClick={onClearHistory} className="text-xs text-red-600 hover:text-red-800 flex items-center gap-1">
                    <Trash2 className="w-3 h-3" /> Clear History
                </button>
            </div>

            <div className="bg-white rounded-xl border border-neutral-200 shadow-sm overflow-hidden">
                <div className="overflow-x-auto max-h-96 overflow-y-auto">
                    <table className="w-full text-left text-sm whitespace-nowrap">
                        <thead className="uppercase tracking-wider border-b-2 border-neutral-200 bg-neutral-50 text-neutral-500 text-[10px] font-semibold sticky top-0">
                            <tr>
                                <th className="px-4 py-3">Role</th>
                                <th className="px-4 py-3">Model</th>
                                <th className="px-4 py-3">Time</th>
                                <th className="px-4 py-3">Speed Score</th>
                                <th className="px-4 py-3">Intelligence</th>
                                <th className="px-4 py-3">Accuracy</th>
                                <th className="px-4 py-3">Status</th>
                                <th className="px-4 py-3">Tested</th>
                                <th className="px-4 py-3">Action</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-neutral-200 text-neutral-800">
                            {history.map(r => (
                                <tr key={`hist-${r.id}-${r.durationMs}`} className="hover:bg-neutral-50">
                                    <td className="px-4 py-3 font-semibold text-xs text-neutral-600">{r.role}</td>
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
                                    <td className="px-4 py-3 text-xs">
                                        {r.error ? (
                                            <span className="text-red-500 font-medium">Error</span>
                                        ) : r.gradingError ? (
                                            <span className="text-amber-500 font-medium" title={r.gradingError}>
                                                Grade failed
                                            </span>
                                        ) : isModelResponseValid(r) ? (
                                            <span className="inline-flex items-center gap-1.5 flex-wrap">
                                                <span className="text-green-600 font-medium">Valid</span>
                                                {r.fromCache && (
                                                    <span title="Grading retrieved from cache" className="px-1.5 py-0.5 bg-slate-100 text-slate-700 rounded text-[10px] font-medium">⚡ cached</span>
                                                )}
                                                {r.consensusSamples && r.consensusSamples > 1 && (
                                                    <span title={`Consensus score from ${r.consensusSamples} samples`} className="px-1.5 py-0.5 bg-indigo-100 text-indigo-800 rounded text-[10px] font-medium">{r.consensusSamples}× vote</span>
                                                )}
                                            </span>
                                        ) : (
                                            <span className="text-amber-500 font-medium" title="Model returned empty or incomplete response">Incomplete</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-xs text-neutral-500 whitespace-nowrap font-mono text-[11px]">
                                        {r.testedAt ? new Date(r.testedAt).toLocaleString() : '—'}
                                    </td>
                                    <td className="px-4 py-3 text-xs">
                                        <button
                                            onClick={() => onApplyToSettings(r)}
                                            title={`Copy ${r.model} into Settings for ${r.role}`}
                                            className="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded text-[11px] font-medium transition-colors"
                                        >
                                            Use this
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};
