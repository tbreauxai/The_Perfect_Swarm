import React from 'react';
import { Loader2, CheckCircle2, AlertCircle, Clock, ChevronDown, ChevronRight, GitFork } from 'lucide-react';

export interface SwarmTimelineEvent {
    id: string;
    timestamp: string;
    agentRole: string;
    action: string;
    modelName: string;
    prompt: string;
    output?: any;
    error?: string;
    durationMs?: number;
}

interface SwarmEventTimelineProps {
    events: SwarmTimelineEvent[];
    expandedEvents: Record<string, boolean>;
    onToggleEvent: (id: string) => void;
}

export const SwarmEventTimeline: React.FC<SwarmEventTimelineProps> = ({
    events,
    expandedEvents,
    onToggleEvent
}) => {
    return (
        <div className="space-y-6 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-neutral-200 before:to-transparent">
            {events.map((event) => {
                const isExpanded = expandedEvents[event.id];
                const isError = !!event.error;
                const isCompletion = event.action.includes("Completed");
                const isRouter = event.agentRole === 'Dynamic Task Router' || event.action === 'Specialist Dynamic Routing';

                return (
                    <div key={event.id} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
                        <div className={`flex items-center justify-center w-10 h-10 rounded-full border-4 border-white shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 shadow-sm ${isError ? 'bg-red-500' : isRouter ? 'bg-purple-600' : isCompletion ? 'bg-green-500' : 'bg-blue-500'}`}>
                            {isError ? (
                                <AlertCircle className="w-4 h-4 text-white" />
                            ) : isRouter ? (
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
                                onClick={() => onToggleEvent(event.id)}
                            >
                                <div>
                                    <h3 className="font-semibold text-neutral-800 text-sm flex items-center gap-2">
                                        {event.agentRole} <span className="text-xs font-normal text-neutral-500 px-2 py-0.5 bg-neutral-100 rounded-full">{event.modelName}</span>
                                    </h3>
                                    <p className="text-xs text-neutral-500 mt-1">{event.action}</p>
                                </div>
                                <div className="flex items-center gap-3">
                                    {event.durationMs !== undefined && (
                                        <span className="text-xs text-neutral-400 flex items-center gap-1">
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
                                    {event.action === 'Specialist Dynamic Routing' && event.output?.assignments ? (
                                        <div className="space-y-4 pt-1">
                                            {/* Metric Overview */}
                                            <div className="grid grid-cols-3 gap-2 text-center">
                                                <div className="p-2.5 bg-neutral-50 rounded-lg border border-neutral-100">
                                                    <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold block">Total Chunks</span>
                                                    <span className="text-base font-bold text-neutral-800">{event.output.totalChunks}</span>
                                                </div>
                                                <div className="p-2.5 bg-neutral-50 rounded-lg border border-neutral-100">
                                                    <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold block">Est. Tokens</span>
                                                    <span className="text-base font-bold text-indigo-600">{event.output.totalEstimatedTokens?.toLocaleString()}</span>
                                                </div>
                                                <div className="p-2.5 bg-neutral-50 rounded-lg border border-neutral-100">
                                                    <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold block">Specialists</span>
                                                    <span className="text-base font-bold text-purple-600">{Object.keys(event.output.specialistSummary || {}).length}</span>
                                                </div>
                                            </div>

                                            {/* Specialist Chunk Assignments */}
                                            <div>
                                                <span className="font-semibold text-neutral-700 text-xs block mb-2">Specialist Allocations & Domain Affinity:</span>
                                                <div className="space-y-2">
                                                    {event.output.assignments.map((asn: any, idx: number) => (
                                                        <div key={idx} className="p-3 bg-neutral-50 rounded-lg border border-neutral-200/80 text-xs space-y-1.5">
                                                            <div className="flex items-center justify-between">
                                                                <span className="font-medium text-neutral-900 flex items-center gap-1.5">
                                                                    <span className="px-1.5 py-0.5 bg-neutral-200 text-neutral-700 rounded text-[10px] font-mono">Chunk {asn.chunkIndex + 1}</span>
                                                                    {asn.isSpillover && (
                                                                        <span className="px-1.5 py-0.5 bg-amber-100 text-amber-800 border border-amber-200 rounded text-[9px] font-semibold">Spillover</span>
                                                                    )}
                                                                    → {asn.agentRole}
                                                                </span>
                                                                <span className="text-[10px] text-neutral-500 bg-white px-2 py-0.5 rounded border border-neutral-200 font-mono">
                                                                    {asn.provider} • {asn.allocatedTokens?.toLocaleString()} tokens
                                                                </span>
                                                            </div>
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-[10px] text-neutral-500 min-w-[75px]">Affinity {Math.round((asn.affinityScore || 0) * 100)}%:</span>
                                                                <div className="flex-1 bg-neutral-200 h-1.5 rounded-full overflow-hidden">
                                                                    <div 
                                                                        className="bg-purple-600 h-full rounded-full" 
                                                                        style={{ width: `${Math.min(100, Math.round((asn.affinityScore || 0) * 100))}%` }} 
                                                                    />
                                                                </div>
                                                                {asn.nodeHeadroom !== undefined && (
                                                                    <span className="text-[10px] text-neutral-400 font-mono">
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

                                            {/* Provider Token Budgets */}
                                            {event.output.tokenBudgets && Object.keys(event.output.tokenBudgets).length > 0 && (
                                                <div>
                                                    <span className="font-semibold text-neutral-700 text-xs block mb-2">Provider Quota & Token Budgets:</span>
                                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                                        {Object.entries(event.output.tokenBudgets).map(([prov, b]: [string, any]) => {
                                                            if (b.totalCumulativeTokens === 0 && b.tokensUsedInWindow === 0) return null;
                                                            const pct = b.utilizationPercent || 0;
                                                            const barColor = pct > 80 ? 'bg-red-500' : pct > 50 ? 'bg-amber-500' : 'bg-green-500';
                                                            return (
                                                                <div key={prov} className="p-2.5 bg-neutral-50 rounded-lg border border-neutral-100 text-xs">
                                                                    <div className="flex justify-between items-center mb-1">
                                                                        <span className="font-semibold text-neutral-800 uppercase text-[10px] tracking-wide">{prov}</span>
                                                                        <span className="text-[10px] text-neutral-500">{pct}% ({b.tokensUsedInWindow?.toLocaleString()} / {b.tpmLimit?.toLocaleString()} TPM)</span>
                                                                    </div>
                                                                    <div className="bg-neutral-200 h-1.5 rounded-full overflow-hidden">
                                                                        <div className={`${barColor} h-full rounded-full transition-all`} style={{ width: `${Math.min(100, pct)}%` }} />
                                                                    </div>
                                                                    <div className="mt-1 text-[10px] text-neutral-400">
                                                                        Cumulative: {b.totalCumulativeTokens?.toLocaleString()} tokens
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            )}

                                            {/* Node Capacity & Headroom */}
                                            {event.output.nodeCapacity && Object.keys(event.output.nodeCapacity).length > 0 && (
                                                <div>
                                                    <span className="font-semibold text-neutral-700 text-xs block mb-2">Node Concurrency & Capacity Headroom:</span>
                                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                                        {Object.entries(event.output.nodeCapacity).map(([nodeId, n]: [string, any]) => {
                                                            const satPct = Math.round((n.saturationRate || 0) * 100);
                                                            const capColor = satPct >= 90 ? 'bg-red-500' : satPct >= 60 ? 'bg-amber-500' : 'bg-blue-500';
                                                            return (
                                                                <div key={nodeId} className="p-2.5 bg-neutral-50 rounded-lg border border-neutral-100 text-xs">
                                                                    <div className="flex justify-between items-center mb-1">
                                                                        <span className="font-semibold text-neutral-800 text-[10px] tracking-wide truncate max-w-[130px]">{nodeId}</span>
                                                                        <span className="text-[10px] text-neutral-500">{n.activeInFlight} / {n.maxConcurrency} in-flight</span>
                                                                    </div>
                                                                    <div className="bg-neutral-200 h-1.5 rounded-full overflow-hidden">
                                                                        <div className={`${capColor} h-full rounded-full transition-all`} style={{ width: `${Math.min(100, satPct)}%` }} />
                                                                    </div>
                                                                    <div className="mt-1 flex justify-between text-[10px] text-neutral-400">
                                                                        <span>Headroom: {Math.round((n.headroom || 0) * 100)}%</span>
                                                                        <span>Slots: {n.totalSlotsAcquired} acq</span>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            )}
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
            })}
        </div>
    );
};
