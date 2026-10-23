import React from 'react';
import { Loader2, CheckCircle2, AlertCircle, Clock, ChevronDown, ChevronRight, GitFork, Calculator, Database, Scale } from 'lucide-react';

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

type StageFilter = 'all' | 'sketch' | 'math' | 'routing' | 'consensus';

const ESTIMATED_ITEM_HEIGHT = 100;
const BUFFER = 8;
const VIEWPORT_HEIGHT = 700;

export const SwarmEventTimeline: React.FC<SwarmEventTimelineProps> = ({
    events,
    expandedEvents,
    onToggleEvent
}) => {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = React.useState(0);
    const [stageFilter, setStageFilter] = React.useState<StageFilter>('all');

    const filteredEvents = React.useMemo(() => {
        if (stageFilter === 'all') return events;
        return events.filter((ev) => {
            if (stageFilter === 'sketch') {
                return ev.action.includes('Columnar Data Sketch') || ev.action.includes('Payload Pre-Filter') || ev.agentRole.includes('Sketcher') || ev.agentRole.includes('Profiler');
            }
            if (stageFilter === 'math') {
                return ev.action.includes('Deterministic Math') || ev.agentRole.includes('Quantitative Grounding');
            }
            if (stageFilter === 'routing') {
                return ev.action.includes('Routing') || ev.action.includes('Communication') || ev.agentRole.includes('Router') || ev.agentRole.includes('Analyst');
            }
            if (stageFilter === 'consensus') {
                return ev.action.includes('Consensus') || ev.agentRole.includes('Consensus') || ev.agentRole.includes('Manager') || ev.agentRole.includes('Critic');
            }
            return true;
        });
    }, [events, stageFilter]);

    const isVirtualized = filteredEvents.length > 50;

    const { startIndex, endIndex, topPadding, bottomPadding } = React.useMemo(() => {
        if (!isVirtualized) {
            return { startIndex: 0, endIndex: filteredEvents.length, topPadding: 0, bottomPadding: 0 };
        }
        const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ESTIMATED_ITEM_HEIGHT) + BUFFER * 2;
        const start = Math.max(0, Math.floor(scrollTop / ESTIMATED_ITEM_HEIGHT) - BUFFER);
        const end = Math.min(filteredEvents.length, start + visibleCount);
        const top = start * ESTIMATED_ITEM_HEIGHT;
        const bottom = Math.max(0, (filteredEvents.length - end) * ESTIMATED_ITEM_HEIGHT);
        return { startIndex: start, endIndex: end, topPadding: top, bottomPadding: bottom };
    }, [isVirtualized, filteredEvents.length, scrollTop]);

    const visibleEvents = isVirtualized ? filteredEvents.slice(startIndex, endIndex) : filteredEvents;

    const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
        setScrollTop(e.currentTarget.scrollTop);
    };

    const filterCounts = React.useMemo(() => ({
        all: events.length,
        sketch: events.filter(e => e.action.includes('Columnar Data Sketch') || e.action.includes('Payload Pre-Filter') || e.agentRole.includes('Sketcher') || e.agentRole.includes('Profiler')).length,
        math: events.filter(e => e.action.includes('Deterministic Math') || e.agentRole.includes('Quantitative Grounding')).length,
        routing: events.filter(e => e.action.includes('Routing') || e.action.includes('Communication') || e.agentRole.includes('Router') || e.agentRole.includes('Analyst')).length,
        consensus: events.filter(e => e.action.includes('Consensus') || e.agentRole.includes('Consensus') || e.agentRole.includes('Manager') || e.agentRole.includes('Critic')).length,
    }), [events]);

    return (
        <div>
            {events.length > 1 && (
                <div className="flex flex-wrap items-center gap-1.5 mb-4 pb-3 border-b border-neutral-100">
                    {([
                        { id: 'all', label: 'All Stages', count: filterCounts.all },
                        { id: 'sketch', label: 'Sketch & Shards', count: filterCounts.sketch },
                        { id: 'math', label: 'Math Grounding', count: filterCounts.math },
                        { id: 'routing', label: 'Specialists & Pods', count: filterCounts.routing },
                        { id: 'consensus', label: 'Consensus & Synthesis', count: filterCounts.consensus },
                    ] as Array<{ id: StageFilter; label: string; count: number }>).map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            onClick={() => setStageFilter(tab.id)}
                            className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                                stageFilter === tab.id
                                    ? 'bg-neutral-900 text-white'
                                    : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                            }`}
                        >
                            <span>{tab.label}</span>
                            <span className={`font-mono tabular-nums text-[10px] ${stageFilter === tab.id ? 'text-neutral-300' : 'text-neutral-400'}`}>
                                {tab.count}
                            </span>
                        </button>
                    ))}
                </div>
            )}

            <div
                ref={containerRef}
                onScroll={isVirtualized ? handleScroll : undefined}
                className={isVirtualized ? "max-h-[700px] overflow-y-auto pr-2 relative" : "relative"}
            >
                {isVirtualized && (
                    <div className="sticky top-0 z-20 flex justify-end mb-2">
                        <span className="text-[11px] font-mono tabular-nums bg-neutral-100/90 backdrop-blur px-2.5 py-1 rounded-full text-neutral-600 border border-neutral-200 shadow-xs">
                            Virtualized: rendering {visibleEvents.length} of {filteredEvents.length} events
                        </span>
                    </div>
                )}
                <div className="space-y-6 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-neutral-200 before:to-transparent">
                    {topPadding > 0 && <div style={{ height: topPadding }} aria-hidden="true" />}
                    {visibleEvents.map((event) => {
                        const isExpanded = expandedEvents[event.id];
                        const isError = !!event.error;
                        const isCompletion = event.action.includes("Completed");
                        const isRouter = event.agentRole === 'Dynamic Task Router' || event.action === 'Specialist Dynamic Routing';
                        const isComm = event.agentRole === 'Hierarchical Communication Layer' || event.action === 'Hierarchical Swarm Communication';
                        const isSketch = event.action === 'Columnar Data Sketch & Anomaly Extraction';
                        const isMath = event.action === 'Deterministic Math & Forecast Grounding';
                        const isConsensus = event.action === 'Cross-Analyst Consensus Synthesized';

                        return (
                            <div key={event.id} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
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
                                        onClick={() => onToggleEvent(event.id)}
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
                                                <div className="space-y-3 pt-1">
                                                    <div className="grid grid-cols-4 gap-2 text-center font-mono tabular-nums">
                                                        <div className="p-2 bg-neutral-50 rounded-lg border border-neutral-100">
                                                            <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-sans font-semibold block">Format</span>
                                                            <span className="text-xs font-bold text-neutral-800 uppercase">{event.output.format}</span>
                                                        </div>
                                                        <div className="p-2 bg-neutral-50 rounded-lg border border-neutral-100">
                                                            <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-sans font-semibold block">Rows</span>
                                                            <span className="text-xs font-bold text-neutral-800">{event.output.totalRows?.toLocaleString()}</span>
                                                        </div>
                                                        <div className="p-2 bg-neutral-50 rounded-lg border border-neutral-100">
                                                            <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-sans font-semibold block">Reduction</span>
                                                            <span className="text-xs font-bold text-teal-700">{Math.round((event.output.compressionRatio || 0) * 100)}%</span>
                                                        </div>
                                                        <div className="p-2 bg-neutral-50 rounded-lg border border-neutral-100">
                                                            <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-sans font-semibold block">Outliers</span>
                                                            <span className="text-xs font-bold text-amber-700">{event.output.anomalyRows?.length ?? event.output.anomalyCount ?? 0}</span>
                                                        </div>
                                                    </div>

                                                    {Array.isArray(event.output.columns) && event.output.columns.length > 0 && (
                                                        <div className="overflow-x-auto border border-neutral-200 rounded-lg">
                                                            <table className="w-full text-left text-[11px] font-mono tabular-nums">
                                                                <thead className="bg-neutral-50 text-neutral-500 border-b border-neutral-200 font-sans">
                                                                    <tr>
                                                                        <th className="py-1.5 px-2.5">Column</th>
                                                                        <th className="py-1.5 px-2">Type</th>
                                                                        <th className="py-1.5 px-2 text-right">Mean</th>
                                                                        <th className="py-1.5 px-2 text-right">Median</th>
                                                                        <th className="py-1.5 px-2 text-right">P75</th>
                                                                        <th className="py-1.5 px-2.5 text-right">Slope</th>
                                                                    </tr>
                                                                </thead>
                                                                <tbody className="divide-y divide-neutral-100">
                                                                    {event.output.columns.map((col: any, idx: number) => (
                                                                        <tr key={idx} className="text-neutral-700">
                                                                            <td className="py-1.5 px-2.5 font-semibold text-neutral-900 truncate max-w-[110px]">{col.name}</td>
                                                                            <td className="py-1.5 px-2 text-neutral-500">{col.type}</td>
                                                                            <td className="py-1.5 px-2 text-right">{col.mean ?? '—'}</td>
                                                                            <td className="py-1.5 px-2 text-right">{col.median ?? col.p50 ?? '—'}</td>
                                                                            <td className="py-1.5 px-2 text-right">{col.p75 ?? col.p95 ?? '—'}</td>
                                                                            <td className="py-1.5 px-2.5 text-right">{col.trendSlope ?? '—'}</td>
                                                                        </tr>
                                                                    ))}
                                                                </tbody>
                                                            </table>
                                                        </div>
                                                    )}
                                                </div>
                                            ) : isMath && event.output ? (
                                                <div className="space-y-3 pt-1">
                                                    <div className="flex items-center justify-between text-xs text-neutral-600 border-b border-neutral-100 pb-2">
                                                        <span>Numeric Series Grounded: <strong className="font-mono tabular-nums text-neutral-900">{event.output.seriesAnchors?.length ?? event.output.seriesCount ?? 0}</strong></span>
                                                        <span>Compute Time: <strong className="font-mono tabular-nums text-indigo-600">{event.output.processingTimeMs ?? event.output.executionTimeMs ?? 0}ms</strong></span>
                                                    </div>
                                                    {Array.isArray(event.output.seriesAnchors) && event.output.seriesAnchors.length > 0 && (
                                                        <div className="space-y-2">
                                                            {event.output.seriesAnchors.map((a: any, idx: number) => (
                                                                <div key={idx} className="p-2.5 bg-neutral-50 rounded-lg border border-neutral-200/80 text-xs space-y-1 font-mono tabular-nums">
                                                                    <div className="flex items-center justify-between font-sans">
                                                                        <span className="font-semibold text-neutral-900">{a.name}</span>
                                                                        <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 font-medium">
                                                                            {a.persistenceRegime || a.growthRegime} (H={a.hurstExponent})
                                                                        </span>
                                                                    </div>
                                                                    <div className="grid grid-cols-3 gap-2 pt-1 text-[11px] text-neutral-600">
                                                                        <div>Mean: <span className="text-neutral-900 font-semibold">{a.mean}</span></div>
                                                                        <div>Next Est: <span className="text-indigo-700 font-semibold">{a.forecastNext3?.[0] ?? '—'}</span></div>
                                                                        <div>VaR95: <span className="text-emerald-700 font-semibold">{a.vaR95}</span></div>
                                                                    </div>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
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
                                                    {/* Metric Overview */}
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

                                                    {/* Specialist Chunk Assignments */}
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
                                                                        <div key={prov} className="p-2.5 bg-neutral-50 rounded-lg border border-neutral-100 text-xs font-mono tabular-nums">
                                                                            <div className="flex justify-between items-center mb-1">
                                                                                <span className="font-semibold text-neutral-800 uppercase text-[10px] tracking-wide font-sans">{prov}</span>
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
                                                                        <div key={nodeId} className="p-2.5 bg-neutral-50 rounded-lg border border-neutral-100 text-xs font-mono tabular-nums">
                                                                            <div className="flex justify-between items-center mb-1">
                                                                                <span className="font-semibold text-neutral-800 text-[10px] tracking-wide truncate max-w-[130px] font-sans">{nodeId}</span>
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
                                            ) : event.action === 'Hierarchical Swarm Communication' && event.output?.digests ? (
                                                <div className="space-y-4 pt-1">
                                                    {/* Hierarchical Metrics Bar */}
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

                                                    {/* Cluster Pod Digests */}
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

                                                                {/* Key Findings */}
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

                                                                {/* Anomalies */}
                                                                {digest.anomalies?.length > 0 && (
                                                                    <div>
                                                                        <span className="text-[10px] font-semibold text-amber-700 uppercase tracking-wider block mb-0.5">Anomalies Flagged:</span>
                                                                        <ul className="list-disc list-inside text-amber-800 space-y-0.5 text-[11px]">
                                                                            {digest.anomalies.map((a: string, aIdx: number) => (
                                                                                <li key={aIdx} className="truncate">{a}</li>
                                                                            ))}
                                                                        </ul>
                                                                    </div>
                                                                )}

                                                                {digest.summary && (
                                                                    <p className="text-[11px] text-neutral-500 italic border-t border-neutral-200/50 pt-1.5">{digest.summary}</p>
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
                    })}
                    {bottomPadding > 0 && <div style={{ height: bottomPadding }} aria-hidden="true" />}
                </div>
            </div>
        </div>
    );
};

