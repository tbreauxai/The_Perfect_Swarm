import React from 'react';

export interface TimelineMathViewProps {
    output: any;
}

export const TimelineMathView: React.FC<TimelineMathViewProps> = ({ output }) => {
    return (
        <div className="space-y-3 pt-1">
            <div className="flex items-center justify-between text-xs text-neutral-600 border-b border-neutral-100 pb-2">
                <span>Numeric Series Grounded: <strong className="font-mono tabular-nums text-neutral-900">{output.seriesAnchors?.length ?? output.seriesCount ?? 0}</strong></span>
                <span>Compute Time: <strong className="font-mono tabular-nums text-indigo-600">{output.processingTimeMs ?? output.executionTimeMs ?? 0}ms</strong></span>
            </div>
            {Array.isArray(output.seriesAnchors) && output.seriesAnchors.length > 0 && (
                <div className="space-y-2">
                    {output.seriesAnchors.map((a: any, idx: number) => (
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
    );
};
