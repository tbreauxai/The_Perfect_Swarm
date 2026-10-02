import React from 'react';
import { Loader2, Play } from 'lucide-react';
import type { OptimizationResult } from './OptimizationRunner';
import { isModelResponseValid } from './optimizationScoring';

export interface OptimizationAgentCardProps {
    agent: any;
    results: OptimizationResult[];
    isRunning: boolean;
    onTestAgent: (agent: any) => void;
}

export const OptimizationAgentCard: React.FC<OptimizationAgentCardProps> = ({
    agent,
    results,
    isRunning,
    onTestAgent
}) => {
    const agentResults = results.filter(r => r.role === agent.role && !r.isFullSwarm);

    return (
        <div className="bg-white border border-neutral-200 rounded-lg p-4 shadow-sm">
            <div className="flex justify-between items-start mb-3">
                <div>
                    <h4 className="font-semibold text-neutral-800">{agent.role}</h4>
                    <span className="text-xs text-neutral-500 uppercase tracking-wider">{agent.provider}</span>
                </div>
                <button
                    onClick={() => onTestAgent(agent)}
                    disabled={isRunning || agent.provider === 'none'}
                    className="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-medium py-1.5 px-3 rounded transition-colors flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                    Test Agent
                </button>
            </div>

            {agentResults.length > 0 ? (
                <div className="space-y-2 mt-4 max-h-64 overflow-y-auto">
                    {agentResults.map(r => (
                        <div key={r.id} className={`p-2 rounded text-xs border ${r.error ? 'bg-red-50 border-red-100' : 'bg-neutral-50 border-neutral-100'}`}>
                            <div className="flex justify-between font-mono font-medium mb-1">
                                <span className="truncate max-w-[150px]">{r.model}</span>
                                <span className={`${r.durationMs < 3000 ? 'text-green-600' : r.durationMs < 8000 ? 'text-amber-600' : 'text-red-600'}`}>
                                    {(r.durationMs / 1000).toFixed(1)}s
                                </span>
                            </div>
                            {r.error ? (
                                <div className="text-red-600 truncate">{r.error}</div>
                            ) : !isModelResponseValid(r) ? (
                                <div className="text-amber-600 text-[10px] italic">Incomplete or empty response</div>
                            ) : (
                                <div className="flex flex-col gap-1">
                                    <div className="flex gap-2 text-[10px] items-center flex-wrap">
                                        <span title="Intelligence" className="px-1.5 py-0.5 bg-blue-100 text-blue-800 rounded">INT: {r.scores.intelligence || '-'}</span>
                                        <span title="Accuracy" className="px-1.5 py-0.5 bg-emerald-100 text-emerald-800 rounded">ACC: {r.scores.accuracy || '-'}</span>
                                        <span title="Speed" className="px-1.5 py-0.5 bg-purple-100 text-purple-800 rounded">SPD: {r.scores.speed || '-'}</span>
                                        {r.fromCache && (
                                            <span title="Grading retrieved from cache" className="px-1.5 py-0.5 bg-slate-100 text-slate-700 rounded font-medium">⚡ cached</span>
                                        )}
                                        {r.consensusSamples && r.consensusSamples > 1 && (
                                            <span title={`Consensus score from ${r.consensusSamples} samples`} className="px-1.5 py-0.5 bg-indigo-100 text-indigo-800 rounded font-medium">{r.consensusSamples}× vote</span>
                                        )}
                                        {r.gradingError && (
                                            <span title={r.gradingError} className="px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded font-medium">Grade failed</span>
                                        )}
                                    </div>
                                    <div className="mt-1 text-[9px] text-neutral-500 max-h-16 overflow-y-auto whitespace-pre-wrap font-mono bg-white p-1 border border-neutral-100 rounded">
                                        {typeof r.output === 'object' ? JSON.stringify(r.output, null, 2) : String(r.output || 'No output')}
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            ) : (
                <p className="text-xs text-neutral-400 mt-4 italic">No results yet. Click test to run model sweep.</p>
            )}
        </div>
    );
};
