import React from 'react';
import { Clock } from 'lucide-react';

export interface OptimizationDurationBadgeProps {
    durationMs: number;
}

export const OptimizationDurationBadge: React.FC<OptimizationDurationBadgeProps> = ({ durationMs }) => {
    const colorClass = durationMs < 3000
        ? 'bg-green-100 text-green-700'
        : durationMs < 8000
        ? 'bg-amber-100 text-amber-700'
        : 'bg-red-100 text-red-700';

    return (
        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${colorClass}`}>
            <Clock className="w-3 h-3" />
            {(durationMs / 1000).toFixed(1)}s
        </span>
    );
};
