import React from 'react';
import { BarChart, Layers, ShieldAlert, CheckCircle2, Loader2 } from 'lucide-react';
import { ComponentRegistry } from './generative/ComponentRegistry';
import type { SwarmTimelineEvent } from './SwarmEventTimeline';

interface AnalysisViewerProps {
    finalAnalysis: any;
    interimDigests?: Record<string, any> | null;
    isSynthesizing?: boolean;
    events?: SwarmTimelineEvent[];
}

export const AnalysisViewer: React.FC<AnalysisViewerProps> = ({ finalAnalysis, interimDigests, isSynthesizing, events = [] }) => {
    const sketchEvent = events.find(e => e.action === 'Columnar Data Sketch & Anomaly Extraction');
    const mathEvent = events.find(e => e.action === 'Deterministic Math & Forecast Grounding');
    const consensusEvent = events.find(e => e.action === 'Cross-Analyst Consensus Synthesized');

    if (!finalAnalysis && (!interimDigests || Object.keys(interimDigests).length === 0) && !sketchEvent && !mathEvent && !consensusEvent) {
        return null;
    }

    return (
        <div className="mt-8 pt-6 border-t border-neutral-200 space-y-6">
            {/* Quantitative Ingestion & Ensemble Telemetry Strip */}
            {(sketchEvent?.output || mathEvent?.output || consensusEvent?.output) && (
                <div className="border border-neutral-200 rounded-xl p-4 bg-neutral-50/60 space-y-3">
                    <div className="flex items-center justify-between border-b border-neutral-200/80 pb-2">
                        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-700">
                            Quantitative Grounding & Ensemble Telemetry
                        </span>
                        {consensusEvent?.output?.agreementLevel && (
                            <span className="text-xs font-mono tabular-nums text-neutral-600">
                                Agreement: <strong className="uppercase text-neutral-900">{consensusEvent.output.agreementLevel}</strong>
                            </span>
                        )}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono tabular-nums">
                        {sketchEvent?.output && (
                            <div>
                                <span className="text-[10px] font-sans uppercase tracking-wider text-neutral-500 block">Sketch Compression</span>
                                <span className="text-sm font-bold text-teal-700">
                                    {Math.round((sketchEvent.output.compressionRatio || 0) * 100)}% saved
                                </span>
                                <span className="text-[11px] text-neutral-500 block">
                                    {sketchEvent.output.totalRows?.toLocaleString()} rows • {sketchEvent.output.anomalyRows?.length ?? sketchEvent.output.anomalyCount ?? 0} outliers
                                </span>
                            </div>
                        )}
                        {mathEvent?.output && (
                            <div>
                                <span className="text-[10px] font-sans uppercase tracking-wider text-neutral-500 block">Math Grounding</span>
                                <span className="text-sm font-bold text-indigo-700">
                                    {mathEvent.output.seriesAnchors?.length ?? 0} series anchored
                                </span>
                                <span className="text-[11px] text-neutral-500 block">
                                    {mathEvent.output.seriesAnchors?.[0] ? `Next Est: ${mathEvent.output.seriesAnchors[0].forecastNext3?.[0]}` : `${mathEvent.output.processingTimeMs ?? 0}ms`}
                                </span>
                            </div>
                        )}
                        {consensusEvent?.output && (
                            <div>
                                <span className="text-[10px] font-sans uppercase tracking-wider text-neutral-500 block">Evidence Consensus</span>
                                <span className="text-sm font-bold text-neutral-900">
                                    {Math.round(((consensusEvent.output.evidenceWeightedScore ?? consensusEvent.output.consensusScore) || 0) * 100)}%
                                </span>
                                <span className="text-[11px] text-neutral-500 block">
                                    {consensusEvent.output.verifiedCitationsCount ?? 0} verified citations
                                </span>
                            </div>
                        )}
                        {consensusEvent?.output?.calibratedEnsemble?.pooledProbability !== undefined && (
                            <div>
                                <span className="text-[10px] font-sans uppercase tracking-wider text-neutral-500 block">Log-Odds Pool</span>
                                <span className="text-sm font-bold text-amber-800">
                                    {(consensusEvent.output.calibratedEnsemble.pooledProbability * 100).toFixed(1)}%
                                </span>
                                <span className="text-[11px] text-neutral-500 block">
                                    95% CI [{Math.round((consensusEvent.output.calibratedEnsemble.confidenceInterval95?.[0] || 0) * 100)}%, {Math.round((consensusEvent.output.calibratedEnsemble.confidenceInterval95?.[1] || 0) * 100)}%]
                                </span>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Interim Progressive Cluster Digest View during Manager Synthesis */}
            {!finalAnalysis && interimDigests && Object.keys(interimDigests).length > 0 && (
                <div className="bg-indigo-50/50 border border-indigo-100 rounded-2xl p-5 space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <Layers className="w-5 h-5 text-indigo-600" />
                            <h3 className="text-base font-semibold text-neutral-800">
                                Progressive Cluster Findings
                            </h3>
                        </div>
                        {isSynthesizing && (
                            <span className="text-xs font-medium text-indigo-700 bg-indigo-100 border border-indigo-200 px-3 py-1 rounded-full flex items-center gap-1.5 animate-pulse">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                Manager Synthesizing Dashboard...
                            </span>
                        )}
                    </div>
                    <p className="text-xs text-neutral-600">
                        Specialist pods completed analysis and streamed consolidated cluster digests. Manager node is synthesizing the final generative UI dashboard.
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 pt-1">
                        {Object.entries(interimDigests).map(([clusterId, digest]: [string, any]) => (
                            <div key={clusterId} className="bg-white border border-neutral-200/80 rounded-xl p-4 shadow-sm space-y-2.5">
                                <div className="flex items-center justify-between border-b border-neutral-100 pb-2">
                                    <span className="text-xs font-semibold uppercase tracking-wider text-neutral-700">
                                        {clusterId}
                                    </span>
                                    {typeof digest.tokenReductionRatio === 'number' && digest.tokenReductionRatio > 0 && (
                                        <span className="text-[11px] font-mono tabular-nums font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md">
                                            {Math.round(digest.tokenReductionRatio * 100)}% token reduction
                                        </span>
                                    )}
                                </div>

                                {digest.specialistRoles && digest.specialistRoles.length > 0 && (
                                    <div className="text-xs text-neutral-500">
                                        Specialists: <span className="text-neutral-700 font-medium">{digest.specialistRoles.join(', ')}</span>
                                    </div>
                                )}

                                {digest.summary && (
                                    <p className="text-xs text-neutral-700 leading-relaxed font-normal">
                                        {digest.summary}
                                    </p>
                                )}

                                {Array.isArray(digest.keyFindings) && digest.keyFindings.length > 0 && (
                                    <div className="space-y-1 pt-1">
                                        <div className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Key Findings</div>
                                        <ul className="space-y-1">
                                            {digest.keyFindings.map((f: string, idx: number) => (
                                                <li key={idx} className="text-xs text-neutral-800 flex items-start gap-1.5">
                                                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0 mt-0.5" />
                                                    <span>{f}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}

                                {Array.isArray(digest.anomalies) && digest.anomalies.length > 0 && (
                                    <div className="space-y-1 pt-1">
                                        <div className="text-[11px] font-semibold text-amber-700 uppercase tracking-wider">Anomalies Detected</div>
                                        <ul className="space-y-1">
                                            {digest.anomalies.map((a: string, idx: number) => (
                                                <li key={idx} className="text-xs text-amber-900 bg-amber-50/70 border border-amber-200/60 rounded px-2 py-1 flex items-start gap-1.5">
                                                    <ShieldAlert className="w-3.5 h-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
                                                    <span>{a}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Final Generative UI Dashboard */}
            {finalAnalysis && (
                <div>
                    <h3 className="text-lg font-semibold text-neutral-800 mb-4 flex items-center gap-2">
                        <BarChart className="w-5 h-5 text-indigo-600" />
                        {finalAnalysis.ui_title || "Generated Dashboard"}
                    </h3>

                    {finalAnalysis.error ? (
                        <div className="bg-red-50 p-5 rounded-xl border border-red-100 text-red-800 text-sm whitespace-pre-wrap leading-relaxed">
                            {finalAnalysis.error}
                        </div>
                    ) : finalAnalysis.components ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {finalAnalysis.components.map((comp: any) => (
                                <div key={comp.id || crypto.randomUUID()} className={comp.type === 'DataTable' ? 'md:col-span-2' : ''}>
                                    <ComponentRegistry component={comp} />
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="bg-indigo-50 p-5 rounded-xl border border-indigo-100 text-neutral-800 text-sm whitespace-pre-wrap leading-relaxed">
                            {JSON.stringify(finalAnalysis, null, 2)}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

