import React from 'react';
import { AlertCircle, Trash2 } from 'lucide-react';

export interface ModelErrorRecord {
    errorCount: number;
    lastError: string;
    provider: string;
}

export interface OptimizationErrorLogProps {
    errorRecords: Record<string, ModelErrorRecord>;
    onClearErrors: () => void;
}

export const OptimizationErrorLog: React.FC<OptimizationErrorLogProps> = ({
    errorRecords,
    onClearErrors
}) => {
    const entries = Object.entries(errorRecords);
    if (entries.length === 0) return null;

    return (
        <div className="bg-white rounded-xl border border-red-200 shadow-sm overflow-hidden mb-6">
            <div className="bg-red-50 px-4 py-3 border-b border-red-200 flex justify-between items-center">
                <h4 className="text-sm font-medium text-red-800 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4" />
                    Model Error Log (Local History)
                </h4>
                <button onClick={onClearErrors} className="text-xs text-red-600 hover:text-red-800 flex items-center gap-1">
                    <Trash2 className="w-3 h-3" /> Clear Log
                </button>
            </div>
            <div className="max-h-48 overflow-y-auto">
                <table className="w-full text-left text-xs whitespace-nowrap">
                    <thead className="bg-white sticky top-0 border-b border-red-100 text-red-500 uppercase">
                        <tr>
                            <th className="px-4 py-2 font-semibold">Model</th>
                            <th className="px-4 py-2 font-semibold">Provider</th>
                            <th className="px-4 py-2 font-semibold">Error Count</th>
                            <th className="px-4 py-2 font-semibold w-full">Last Error Message</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-red-50">
                        {entries.sort((a, b) => (b[1] as ModelErrorRecord).errorCount - (a[1] as ModelErrorRecord).errorCount).map(([modelId, record]) => (
                            <tr key={modelId} className="hover:bg-red-50/50">
                                <td className="px-4 py-2 font-mono text-red-700">{modelId}</td>
                                <td className="px-4 py-2 uppercase tracking-wide text-red-400">{(record as ModelErrorRecord).provider}</td>
                                <td className="px-4 py-2 font-semibold text-red-600">{(record as ModelErrorRecord).errorCount}</td>
                                <td className="px-4 py-2 truncate max-w-md text-red-500 font-mono" title={(record as ModelErrorRecord).lastError}>{(record as ModelErrorRecord).lastError}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};
