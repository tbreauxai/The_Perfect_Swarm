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

export type StageFilter = 'all' | 'sketch' | 'math' | 'routing' | 'consensus';
