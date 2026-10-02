export type TaskPriority = 'urgent' | 'high' | 'normal' | 'background';

export type SchedulingStrategy =
    | 'priority'
    | 'shortest-job-first'
    | 'least-loaded'
    | 'fair-share'
    | 'work-stealing';

export interface ScheduledTask<T = any, R = any> {
    id: string;
    priority?: TaskPriority;
    assignedWorkerId?: string;
    targetProvider?: string;
    domain?: string;
    estimatedTokens?: number;
    estimatedDurationMs?: number;
    payload?: T;
    execute: (task: ScheduledTask<T, R>) => Promise<R>;
    createdAt?: number;
    startedAt?: number;
    completedAt?: number;
    retries?: number;
    maxRetries?: number;
    backpressureDelayMs?: number;
    stolenByWorkerId?: string;
}

export interface TaskExecutionSummary<R = any> {
    taskId: string;
    workerId: string;
    result?: R;
    error?: Error;
    success: boolean;
    queueWaitMs: number;
    executionMs: number;
    backpressureDelayMs: number;
    wasStolen: boolean;
    stolenFrom?: string;
}

export interface SchedulerExecutionResult<R = any> {
    results: Array<TaskExecutionSummary<R>>;
    totalTasks: number;
    successfulTasks: number;
    failedTasks: number;
    totalQueueWaitMs: number;
    averageQueueWaitMs: number;
    totalExecutionMs: number;
    totalBackpressureDelayMs: number;
    stolenTaskCount: number;
}

export interface SchedulerTelemetryEvent {
    type: 'task_scheduled' | 'task_started' | 'task_completed' | 'task_failed' | 'work_stolen' | 'backpressure_delay';
    taskId: string;
    workerId?: string;
    provider?: string;
    priority?: TaskPriority;
    delayMs?: number;
    durationMs?: number;
    metadata?: Record<string, any>;
    timestamp: number;
}

export interface ProviderRateLimitProfile {
    maxRpm: number;
    maxTpm: number;
}

export interface SchedulerConfig {
    strategy?: SchedulingStrategy;
    maxConcurrency?: number;
    enableRateLimiting?: boolean;
    agingThresholdMs?: number;
    rateLimits?: Record<string, Partial<ProviderRateLimitProfile>>;
    onEvent?: (event: SchedulerTelemetryEvent) => void;
}
