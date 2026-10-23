import React from 'react';
import {
    Loader2,
    CheckCircle2,
    AlertCircle,
    Clock,
    ChevronDown,
    ChevronRight,
    GitFork,
    Calculator,
    Database,
    Scale
} from 'lucide-react';
import type { SwarmTimelineEvent } from './types';
import { TimelineSketchView } from './TimelineSketchView';
import { TimelineMathView } from './TimelineMathView';

export interface TimelineItemProps {
    event: SwarmTimelineEvent;
    isExpanded: boolean;
    onToggle: () => void;
}

export const TimelineItem: React.FC<TimelineItemProps> = ({ event, isExpanded, onToggle }) => {
    const isError = !!event.error;
    const isCompletion = event.action.includes("Completed");
    const isRouter = event.agentRole === 'Dynamic Task Router' || event.action === 'Specialist Dynamic Routing';
    const isComm = event.agentRole === 'Hierarchical Communication Layer' || event.action === 'Hierarchical Swarm Communication';
    const isSketch = event.action === 'Columnar Data Sketch & Anomaly Extraction';
    const isMath = event.action === 'Deterministic Math & Forecast Grounding';
    const isConsensus = event.action === 'Cross-Analyst Consensus Synthesized';

    return (
        <div className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
            <div className={`flex items-center justify-center w-10 h-10 rounded-full border-4 border-white shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 shadow-sm ${
                isError ? 'bg-red-500'
                : isSketch ? 'bg-teal-600'
                : isMath ? 'bg-indigo-600'
                : isConsensus ? 'bg-amber-600'
                : isRouter ? 'bg-purple-600'
                : isComm ? 'bg-emerald-600'
                : isCompletion ? 'bg-green-500'
                : 'bg-blue-500'
            }`}>
                {isError ? (
                    <AlertCircle className="w-4 h-4 text-white" />
                ) : isSketch ? (
                    <Database className="w-4 h-4 text-white" />
                ) : isMath ? (
                    <Calculator className="w-4 h-4 text-white" />
                ) : isConsensus ? (
                    <Scale className="w-4 h-4 text-white" />
                ) : isRouter || isComm ? (
                    <GitFork className="w-4 h-4 text-white" />
                ) : isCompletion ? (
                    <CheckCircle2 className="w-4 h-4 text-white" />
                ) : (
                    <Loader2 className="w-4 h-4 text-white animate-spin" style={{ animationDuration: '3s' }} />
                )}
            </div>

            <div className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] p-4 rounded-xl border border-neutral-200 bg-white shadow-sm hover:shadow-md transition-shadow">
                <div
                    className="flex items-center justify-between cursor-pointer"
                    onClick={onToggle}
                >
                    <div>
                        <h3 className="font-semibold text-neutral-800 text-sm flex items-center gap-2">
                            {event.agentRole} <span className="text-xs font-normal text-neutral-500 px-2 py-0.5 bg-neutral-100 rounded-full font-mono">{event.modelName}</span>
                        </h3>
                        <p className="text-xs text-neutral-500 mt-1">{event.action}</p>
                    </div>
                    <div className="flex items-center gap-3">
                        {event.durationMs !== undefined && (
                            <span className="text-xs text-neutral-400 font-mono tabular-nums flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {event.durationMs}ms
                            </span>
                        )}
                        {isExpanded ? <ChevronDown className="w-4 h-4 text-neutral-400" /> : <ChevronRight className="w-4 h-4 text-neutral-400" />}
                    </div>
                </div>

                {isExpanded && (
                    <div className="mt-4 space-y-4 border-t border-neutral-100 pt-4 text-sm">
                        {event.prompt && (
                            <div>
                                <span className="font-semibold text-neutral-700 block mb-1">Prompt:</span>
                                <pre className="bg-neutral-50 p-3 rounded-lg border border-neutral-100 text-xs text-neutral-600 whitespace-pre-wrap max-h-40 overflow-y-auto font-mono">
                                    {event.prompt}
                                </pre>
                            </div>
                        )}

                        {isSketch && event.output ? (
                            <TimelineSketchView output={event.output} />
                        ) : isMath && event.output ? (
                            <TimelineMathView output={event.output} />
                        ) : isConsensus && event.output ? (
                            <div className="space-y-3 pt-1">
                                <div className="grid grid-cols-3 gap-2 text-center font-mono tabular-nums">
                                    <div className="p-2 bg-neutral-50 rounded-lg border border-neutral-100">
                                        <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-sans font-semibold block">Consensus</span>
                                        <span className="text-xs font-bold text-neutral-900">{Math.round((event.output.consensusScore || 0) * 100)}%</span>
                                    </div>
                                    <div className="p-2 bg-neutral-50 rounded-lg border border-neutral-100">
                                        <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-sans font-semibold block">Evidence Score</span>
                                        <span className="text-xs font-bold text-indigo-600">
                                            {event.output.evidenceWeightedScore !== undefined ? `${Math.round(event.output.evidenceWeightedScore * 100)}%` : '—'}
                                        </span>
                                    </div>
                                    <div className="p-2 bg-neutral-50 rounded-lg border border-neutral-100">
                                        <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-sans font-semibold block">Verified Citations</span>
                                        <span className="text-xs font-bold text-emerald-700">{event.output.verifiedCitationsCount ?? 0}</span>
                                    </div>
                                </div>
                                {event.output.calibratedEnsemble?.pooledProbability !== undefined && (
                                    <div className="p-2.5 bg-amber-50/70 rounded-lg border border-amber-200/80 text-xs font-mono tabular-nums flex items-center justify-between">
                                        <span className="font-sans font-medium text-amber-900">Brier Log-Odds Pooled Probability:</span>
                                        <span className="font-bold text-amber-900">
                                            {(event.output.calibratedEnsemble.pooledProbability * 100).toFixed(1)}% (k={event.output.calibratedEnsemble.extremizingFactorK})
                                        </span>
                                    </div>
                                )}
                            </div>
                        ) : event.action === 'Specialist Dynamic Routing' && event.output?.assignments ? (
                            <div className="space-y-4 pt-1">
                                <div className="grid grid-cols-3 gap-2 text-center font-mono tabular-nums">
                                    <div className="p-2.5 bg-neutral-50 rounded-lg border border-neutral-100">
                                        <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-sans font-semibold block">Total Chunks</span>
                                        <span className="text-base font-bold text-neutral-800">{event.output.totalChunks}</span>
                                    </div>
                                    <div className="p-2.5 bg-neutral-50 rounded-lg border border-neutral-100">
                                        <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-sans font-semibold block">Est. Tokens</span>
                                        <span className="text-base font-bold text-indigo-600">{event.output.totalEstimatedTokens?.toLocaleString()}</span>
                                    </div>
                                    <div className="p-2.5 bg-neutral-50 rounded-lg border border-neutral-100">
                                        <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-sans font-semibold block">Specialists</span>
                                        <span className="text-base font-bold text-purple-600">{Object.keys(event.output.specialistSummary || {}).length}</span>
                                    </div>
                                </div>

                                <div>
                                    <span className="font-semibold text-neutral-700 text-xs block mb-2">Specialist Allocations & Domain Affinity:</span>
                                    <div className="space-y-2">
                                        {event.output.assignments.map((asn: any, idx: number) => (
                                            <div key={idx} className="p-3 bg-neutral-50 rounded-lg border border-neutral-200/80 text-xs space-y-1.5">
                                                <div className="flex items-center justify-between">
                                                    <span className="font-medium text-neutral-900 flex items-center gap-1.5">
                                                        <span className="px-1.5 py-0.5 bg-neutral-200 text-neutral-700 rounded text-[10px] font-mono tabular-nums">Chunk {asn.chunkIndex + 1}</span>
                                                        {asn.isSpillover && (
                                                            <span className="px-1.5 py-0.5 bg-amber-100 text-amber-800 border border-amber-200 rounded text-[9px] font-semibold">Spillover</span>
                                                        )}
                                                        → {asn.agentRole}
                                                    </span>
                                                    <span className="text-[10px] text-neutral-500 bg-white px-2 py-0.5 rounded border border-neutral-200 font-mono tabular-nums">
                                                        {asn.provider} • {asn.allocatedTokens?.toLocaleString()} tokens
                                                    </span>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] text-neutral-500 min-w-[75px] font-mono tabular-nums">Affinity {Math.round((asn.affinityScore || 0) * 100)}%:</span>
                                                    <div className="flex-1 bg-neutral-200 h-1.5 rounded-full overflow-hidden">
                                                        <div 
                                                            className="bg-purple-600 h-full rounded-full" 
                                                            style={{ width: `${Math.min(100, Math.round((asn.affinityScore || 0) * 100))}%` }} 
                                                        />
                                                    </div>
                                                    {asn.nodeHeadroom !== undefined && (
                                                        <span className="text-[10px] text-neutral-400 font-mono tabular-nums">
                                                            {Math.round(asn.nodeHeadroom * 100)}% cap
                                                        </span>
                                                    )}
                                                </div>
                                                {asn.reason && (
                                                    <p className="text-[11px] text-neutral-500 italic">{asn.reason}</p>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        ) : event.action === 'Hierarchical Swarm Communication' && event.output?.digests ? (
                            <div className="space-y-4 pt-1">
                                <div className="grid grid-cols-4 gap-2 text-center font-mono tabular-nums">
                                    <div className="p-2.5 bg-neutral-50 rounded-lg border border-neutral-100">
                                        <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-sans font-semibold block">Clusters</span>
                                        <span className="text-base font-bold text-neutral-800">{Object.keys(event.output.digests).length}</span>
                                    </div>
                                    <div className="p-2.5 bg-neutral-50 rounded-lg border border-neutral-100">
                                        <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-sans font-semibold block">Messages</span>
                                        <span className="text-base font-bold text-blue-600">{event.output.metrics?.totalSent ?? 0}</span>
                                    </div>
                                    <div className="p-2.5 bg-neutral-50 rounded-lg border border-neutral-100">
                                        <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-sans font-semibold block">Deduped</span>
                                        <span className="text-base font-bold text-amber-600">{event.output.metrics?.duplicatesSuppressed ?? 0}</span>
                                    </div>
                                    <div className="p-2.5 bg-neutral-50 rounded-lg border border-neutral-100">
                                        <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-sans font-semibold block">Token Savings</span>
                                        <span className="text-base font-bold text-emerald-600">{Math.round((event.output.metrics?.overallCompressionRatio || 0) * 100)}%</span>
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <span className="font-semibold text-neutral-700 text-xs block mb-1">Consolidated Cluster Pod Digests:</span>
                                    {Object.entries(event.output.digests).map(([cId, digest]: [string, any]) => (
                                        <div key={cId} className="p-3 bg-neutral-50 rounded-lg border border-neutral-200/80 text-xs space-y-2">
                                            <div className="flex items-center justify-between">
                                                <span className="font-semibold text-neutral-900 flex items-center gap-1.5">
                                                    <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-800 border border-emerald-200 rounded text-[10px] font-mono">{cId}</span>
                                                    <span className="text-neutral-500 font-normal">({digest.specialistRoles?.join(', ')})</span>
                                                </span>
                                                <span className="text-[10px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 font-mono tabular-nums font-medium">
                                                    {Math.round((digest.tokenReductionRatio || 0) * 100)}% token reduction
                                                </span>
                                            </div>
                                            {digest.keyFindings?.length > 0 && (
                                                <div>
                                                    <span className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider block mb-1">Key Findings:</span>
                                                    <ul className="list-disc list-inside text-neutral-700 space-y-0.5 text-[11px]">
                                                        {digest.keyFindings.map((f: string, fIdx: number) => (
                                                            <li key={fIdx} className="truncate">{f}</li>
                                                        ))}
                                                    </ul>
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : event.output ? (
                            <div>
                                <span className="font-semibold text-green-700 block mb-1">Output:</span>
                                <pre className="bg-green-50 p-3 rounded-lg border border-green-100 text-xs text-green-800 whitespace-pre-wrap max-h-64 overflow-y-auto font-mono">
                                    {typeof event.output === 'object' ? JSON.stringify(event.output, null, 2) : event.output}
                                </pre>
                            </div>
                        ) : null}

                        {event.error && (
                            <div>
                                <span className="font-semibold text-red-700 block mb-1">Error:</span>
                                <div className="bg-red-50 p-3 rounded-lg border border-red-100 text-xs text-red-700 font-mono">
                                    {event.error}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
