import React from 'react';
import { Loader2, CheckCircle2, AlertCircle, Clock, ChevronDown, ChevronRight } from 'lucide-react';

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

                return (
                    <div key={event.id} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
                        <div className={`flex items-center justify-center w-10 h-10 rounded-full border-4 border-white shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 shadow-sm ${isError ? 'bg-red-500' : isCompletion ? 'bg-green-500' : 'bg-blue-500'}`}>
                            {isError ? (
                                <AlertCircle className="w-4 h-4 text-white" />
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
                                    {event.output && (
                                        <div>
                                            <span className="font-semibold text-green-700 block mb-1">Output:</span>
                                            <pre className="bg-green-50 p-3 rounded-lg border border-green-100 text-xs text-green-800 whitespace-pre-wrap max-h-64 overflow-y-auto font-mono">
                                                {typeof event.output === 'object' ? JSON.stringify(event.output, null, 2) : event.output}
                                            </pre>
                                        </div>
                                    )}
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
