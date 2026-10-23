import React from 'react';

export interface TimelineSketchViewProps {
    output: any;
}

export const TimelineSketchView: React.FC<TimelineSketchViewProps> = ({ output }) => {
    return (
        <div className="space-y-3 pt-1">
            <div className="grid grid-cols-4 gap-2 text-center font-mono tabular-nums">
                <div className="p-2 bg-neutral-50 rounded-lg border border-neutral-100">
                    <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-sans font-semibold block">Format</span>
                    <span className="text-xs font-bold text-neutral-800 uppercase">{output.format}</span>
                </div>
                <div className="p-2 bg-neutral-50 rounded-lg border border-neutral-100">
                    <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-sans font-semibold block">Rows</span>
                    <span className="text-xs font-bold text-neutral-800">{output.totalRows?.toLocaleString()}</span>
                </div>
                <div className="p-2 bg-neutral-50 rounded-lg border border-neutral-100">
                    <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-sans font-semibold block">Reduction</span>
                    <span className="text-xs font-bold text-teal-700">{Math.round((output.compressionRatio || 0) * 100)}%</span>
                </div>
                <div className="p-2 bg-neutral-50 rounded-lg border border-neutral-100">
                    <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-sans font-semibold block">Outliers</span>
                    <span className="text-xs font-bold text-amber-700">{output.anomalyRows?.length ?? output.anomalyCount ?? 0}</span>
                </div>
            </div>

            {Array.isArray(output.columns) && output.columns.length > 0 && (
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
                            {output.columns.map((col: any, idx: number) => (
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
    );
};
