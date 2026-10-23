import React from 'react';
import type { StageFilter } from './types';

export interface TimelineStageTabsProps {
    stageFilter: StageFilter;
    onSelectFilter: (filter: StageFilter) => void;
    counts: {
        all: number;
        sketch: number;
        math: number;
        routing: number;
        consensus: number;
    };
}

export const TimelineStageTabs: React.FC<TimelineStageTabsProps> = ({
    stageFilter,
    onSelectFilter,
    counts
}) => {
    const tabs: Array<{ id: StageFilter; label: string; count: number }> = [
        { id: 'all', label: 'All Stages', count: counts.all },
        { id: 'sketch', label: 'Sketch & Shards', count: counts.sketch },
        { id: 'math', label: 'Math Grounding', count: counts.math },
        { id: 'routing', label: 'Specialists & Pods', count: counts.routing },
        { id: 'consensus', label: 'Consensus & Synthesis', count: counts.consensus },
    ];

    return (
        <div className="flex flex-wrap items-center gap-1.5 mb-4 pb-3 border-b border-neutral-100">
            {tabs.map((tab) => (
                <button
                    key={tab.id}
                    type="button"
                    onClick={() => onSelectFilter(tab.id)}
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
    );
};
