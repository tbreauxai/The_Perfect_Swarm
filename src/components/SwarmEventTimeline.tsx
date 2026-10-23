import React from 'react';
import type { SwarmTimelineEvent, StageFilter } from './timeline/types';
import { TimelineStageTabs } from './timeline/TimelineStageTabs';
import { TimelineItem } from './timeline/TimelineItem';

export type { SwarmTimelineEvent, StageFilter } from './timeline/types';

export interface SwarmEventTimelineProps {
    events: SwarmTimelineEvent[];
    expandedEvents: Record<string, boolean>;
    onToggleEvent: (id: string) => void;
}

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
                <TimelineStageTabs
                    stageFilter={stageFilter}
                    onSelectFilter={setStageFilter}
                    counts={filterCounts}
                />
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
                    {visibleEvents.map((event) => (
                        <TimelineItem
                            key={event.id}
                            event={event}
                            isExpanded={!!expandedEvents[event.id]}
                            onToggle={() => onToggleEvent(event.id)}
                        />
                    ))}
                    {bottomPadding > 0 && <div style={{ height: bottomPadding }} aria-hidden="true" />}
                </div>
            </div>
        </div>
    );
};
