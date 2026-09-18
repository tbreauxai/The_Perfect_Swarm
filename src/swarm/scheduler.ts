/**
 * Adaptive Load-Balancing & Task-Scheduling Engine
 * 
 * Provides priority-aware task queueing, work-stealing across specialist workers,
 * predictive EWMA latency modeling, and token-bucket rate-limit backpressure pacing.
 * Pure TypeScript, zero external runtime dependencies.
 */

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

const PRIORITY_SCORES: Record<TaskPriority, number> = {
    urgent: 100,
    high: 50,
    normal: 20,
    background: 5
};

/**
 * Priority Task Queue with starvation aging prevention.
 * Higher priority items are dequeued first. Tasks waiting beyond agingThresholdMs
 * receive a priority elevation to guarantee bounded wait time.
 */
export class PriorityTaskQueue<T = any, R = any> {
    private queue: Array<ScheduledTask<T, R>> = [];
    private agingThresholdMs: number;

    constructor(agingThresholdMs: number = 5000) {
        this.agingThresholdMs = agingThresholdMs;
    }

    enqueue(task: ScheduledTask<T, R>): void {
        task.createdAt = task.createdAt ?? Date.now();
        task.priority = task.priority ?? 'normal';
        this.queue.push(task);
        this.sortQueue();
    }

    enqueueBatch(tasks: Array<ScheduledTask<T, R>>): void {
        const now = Date.now();
        for (const t of tasks) {
            t.createdAt = t.createdAt ?? now;
            t.priority = t.priority ?? 'normal';
            this.queue.push(t);
        }
        this.sortQueue();
    }

    dequeue(): ScheduledTask<T, R> | undefined {
        if (this.queue.length === 0) return undefined;
        this.sortQueue();
        return this.queue.shift();
    }

    peek(): ScheduledTask<T, R> | undefined {
        if (this.queue.length === 0) return undefined;
        this.sortQueue();
        return this.queue[0];
    }

    size(): number {
        return this.queue.length;
    }

    isEmpty(): boolean {
        return this.queue.length === 0;
    }

    remove(taskId: string): boolean {
        const idx = this.queue.findIndex(t => t.id === taskId);
        if (idx !== -1) {
            this.queue.splice(idx, 1);
            return true;
        }
        return false;
    }

    clear(): void {
        this.queue = [];
    }

    getAll(): Array<ScheduledTask<T, R>> {
        return [...this.queue];
    }

    private computeEffectiveScore(task: ScheduledTask<T, R>, now: number): number {
        const baseScore = PRIORITY_SCORES[task.priority ?? 'normal'] ?? 20;
        const waitMs = now - (task.createdAt ?? now);
        // Elevate priority by 10 points for each full aging threshold elapsed
        const agingBonus = Math.floor(waitMs / this.agingThresholdMs) * 10;
        return baseScore + agingBonus;
    }

    private sortQueue(): void {
        const now = Date.now();
        this.queue.sort((a, b) => {
            const scoreA = this.computeEffectiveScore(a, now);
            const scoreB = this.computeEffectiveScore(b, now);
            if (scoreB !== scoreA) {
                return scoreB - scoreA;
            }
            // Tie-break: FIFO order by createdAt
            return (a.createdAt ?? 0) - (b.createdAt ?? 0);
        });
    }
}

/**
 * Token Bucket & Sliding Window Rate Limiter.
 * Tracks Requests Per Minute (RPM) and Tokens Per Minute (TPM) per provider,
 * calculating required backpressure delays to avoid 429 quota exhaustion.
 */
export class TokenBucketRateLimiter {
    private profiles: Map<string, ProviderRateLimitProfile> = new Map();
    private requestBuckets: Map<string, { count: number; lastReplenishMs: number }> = new Map();
    private tokenBuckets: Map<string, { tokens: number; lastReplenishMs: number }> = new Map();

    constructor(customLimits?: Record<string, Partial<ProviderRateLimitProfile>>) {
        // Calibrated baseline free-tier rate limits:
        const defaults: Record<string, ProviderRateLimitProfile> = {
            groq: { maxRpm: 30, maxTpm: 6000 },
            mistral: { maxRpm: 60, maxTpm: 12000 },
            github: { maxRpm: 15, maxTpm: 8000 },
            openrouter: { maxRpm: 60, maxTpm: 15000 },
            gemini: { maxRpm: 120, maxTpm: 30000 },
            simulated: { maxRpm: 10000, maxTpm: 1000000 },
            mock: { maxRpm: 10000, maxTpm: 1000000 },
            default: { maxRpm: 60, maxTpm: 10000 }
        };

        for (const [k, v] of Object.entries(defaults)) {
            this.profiles.set(k.toLowerCase(), v);
        }

        if (customLimits) {
            for (const [k, v] of Object.entries(customLimits)) {
                const def = this.getProfile(k);
                this.profiles.set(k.toLowerCase(), {
                    maxRpm: v.maxRpm ?? def.maxRpm,
                    maxTpm: v.maxTpm ?? def.maxTpm
                });
            }
        }
    }

    private normalizeKey(provider?: string): string {
        return (provider || 'default').toLowerCase().trim();
    }

    getProfile(provider?: string): ProviderRateLimitProfile {
        const key = this.normalizeKey(provider);
        return this.profiles.get(key) ?? this.profiles.get('default')!;
    }

    setProfile(provider: string, profile: Partial<ProviderRateLimitProfile>): void {
        const key = this.normalizeKey(provider);
        const curr = this.getProfile(key);
        this.profiles.set(key, {
            maxRpm: profile.maxRpm ?? curr.maxRpm,
            maxTpm: profile.maxTpm ?? curr.maxTpm
        });
    }

    private replenish(provider: string, now: number): { requestTokens: number; tokenAllowance: number } {
        const key = this.normalizeKey(provider);
        const profile = this.getProfile(key);

        // Replenish request bucket
        let reqBucket = this.requestBuckets.get(key);
        if (!reqBucket) {
            reqBucket = { count: profile.maxRpm, lastReplenishMs: now };
            this.requestBuckets.set(key, reqBucket);
        } else {
            const elapsed = Math.max(0, now - reqBucket.lastReplenishMs);
            const added = (elapsed / 60000) * profile.maxRpm;
            reqBucket.count = Math.min(profile.maxRpm, reqBucket.count + added);
            reqBucket.lastReplenishMs = now;
        }

        // Replenish token bucket
        let tokBucket = this.tokenBuckets.get(key);
        if (!tokBucket) {
            tokBucket = { tokens: profile.maxTpm, lastReplenishMs: now };
            this.tokenBuckets.set(key, tokBucket);
        } else {
            const elapsed = Math.max(0, now - tokBucket.lastReplenishMs);
            const added = (elapsed / 60000) * profile.maxTpm;
            tokBucket.tokens = Math.min(profile.maxTpm, tokBucket.tokens + added);
            tokBucket.lastReplenishMs = now;
        }

        return { requestTokens: reqBucket.count, tokenAllowance: tokBucket.tokens };
    }

    /**
     * Calculates delay in milliseconds needed before acquiring tokens for provider.
     * Returns 0 if sufficient capacity is currently available.
     */
    getDelayUntilAvailable(provider?: string, estimatedTokens: number = 200, now: number = Date.now()): number {
        const key = this.normalizeKey(provider);
        const profile = this.getProfile(key);
        const { requestTokens, tokenAllowance } = this.replenish(key, now);

        let delayMs = 0;

        if (requestTokens < 1) {
            const neededReqs = 1 - requestTokens;
            const reqDelay = (neededReqs / profile.maxRpm) * 60000;
            delayMs = Math.max(delayMs, reqDelay);
        }

        if (tokenAllowance < estimatedTokens) {
            const neededTokens = estimatedTokens - tokenAllowance;
            const tokDelay = (neededTokens / profile.maxTpm) * 60000;
            delayMs = Math.max(delayMs, tokDelay);
        }

        return Math.ceil(delayMs);
    }

    canAcquire(provider?: string, estimatedTokens: number = 200, now: number = Date.now()): boolean {
        return this.getDelayUntilAvailable(provider, estimatedTokens, now) === 0;
    }

    /**
     * Consumes tokens for a scheduled execution if available.
     * Returns true if successfully acquired, false if rate limit would be exceeded.
     */
    acquire(provider?: string, estimatedTokens: number = 200, now: number = Date.now()): boolean {
        const key = this.normalizeKey(provider);
        if (!this.canAcquire(key, estimatedTokens, now)) {
            return false;
        }

        const reqBucket = this.requestBuckets.get(key)!;
        const tokBucket = this.tokenBuckets.get(key)!;

        reqBucket.count = Math.max(0, reqBucket.count - 1);
        tokBucket.tokens = Math.max(0, tokBucket.tokens - estimatedTokens);

        return true;
    }

    reset(): void {
        this.requestBuckets.clear();
        this.tokenBuckets.clear();
    }
}

/**
 * Predictive Latency Model using Exponential Weighted Moving Averages (EWMA).
 * Predicts task execution latency based on domain, provider, and estimated token length.
 */
export class PredictiveLatencyModel {
    private emaLatencies: Map<string, number> = new Map();
    private alpha: number;
    private tokenCostFactorMs: number;

    constructor(alpha: number = 0.3, tokenCostFactorMs: number = 0.15) {
        this.alpha = alpha;
        this.tokenCostFactorMs = tokenCostFactorMs;
    }

    private makeKey(domain?: string, provider?: string): string {
        const d = (domain || 'general').toLowerCase();
        const p = (provider || 'default').toLowerCase();
        return `${d}:${p}`;
    }

    predictDurationMs(domain?: string, provider?: string, estimatedTokens: number = 200): number {
        const key = this.makeKey(domain, provider);
        const provKey = (provider || 'default').toLowerCase();

        const baseLatency = this.emaLatencies.get(key)
            ?? this.emaLatencies.get(provKey)
            ?? 400; // Default estimate 400ms

        const tokenExtra = estimatedTokens * this.tokenCostFactorMs;
        return Math.round(baseLatency + tokenExtra);
    }

    recordCompletion(domain: string | undefined, provider: string | undefined, estimatedTokens: number, actualDurationMs: number): void {
        const key = this.makeKey(domain, provider);
        const provKey = (provider || 'default').toLowerCase();

        const prevKey = this.emaLatencies.get(key);
        if (prevKey === undefined) {
            this.emaLatencies.set(key, actualDurationMs);
        } else {
            this.emaLatencies.set(key, Math.round((this.alpha * actualDurationMs) + ((1 - this.alpha) * prevKey)));
        }

        const prevProv = this.emaLatencies.get(provKey);
        if (prevProv === undefined) {
            this.emaLatencies.set(provKey, actualDurationMs);
        } else {
            this.emaLatencies.set(provKey, Math.round((this.alpha * actualDurationMs) + ((1 - this.alpha) * prevProv)));
        }
    }

    reset(): void {
        this.emaLatencies.clear();
    }
}

/**
 * Work-Stealing Pool.
 * Each worker possesses a local task queue. Idle workers dynamically steal pending
 * tasks from the tail of the busiest worker's queue to balance load across specialists.
 */
export class WorkStealingPool<T = any, R = any> {
    private workerQueues: Map<string, Array<ScheduledTask<T, R>>> = new Map();
    private stats: Map<string, { executed: number; stolen: number; surrendered: number }> = new Map();

    registerWorker(workerId: string): void {
        if (!this.workerQueues.has(workerId)) {
            this.workerQueues.set(workerId, []);
            this.stats.set(workerId, { executed: 0, stolen: 0, surrendered: 0 });
        }
    }

    unregisterWorker(workerId: string): void {
        this.workerQueues.delete(workerId);
        this.stats.delete(workerId);
    }

    getRegisteredWorkers(): string[] {
        return Array.from(this.workerQueues.keys());
    }

    submitTask(workerId: string, task: ScheduledTask<T, R>): void {
        this.registerWorker(workerId);
        task.assignedWorkerId = workerId;
        task.createdAt = task.createdAt ?? Date.now();
        this.workerQueues.get(workerId)!.push(task);
    }

    getQueueDepth(workerId: string): number {
        return this.workerQueues.get(workerId)?.length ?? 0;
    }

    getTotalPending(): number {
        let total = 0;
        for (const q of this.workerQueues.values()) {
            total += q.length;
        }
        return total;
    }

    /**
     * Worker attempts to pop its own task first (FIFO).
     * If local queue is empty, worker attempts to steal a task from the busiest worker's queue (LIFO / tail).
     */
    pollNextTask(workerId: string): { task?: ScheduledTask<T, R>; wasStolen: boolean; stolenFrom?: string } {
        this.registerWorker(workerId);
        const localQueue = this.workerQueues.get(workerId)!;

        // 1. Check local queue
        if (localQueue.length > 0) {
            const task = localQueue.shift()!;
            const workerStat = this.stats.get(workerId)!;
            workerStat.executed++;
            return { task, wasStolen: false };
        }

        // 2. Local queue empty: attempt to steal from the busiest worker
        let busiestWorker: string | undefined;
        let maxDepth = 0;

        for (const [wId, queue] of this.workerQueues.entries()) {
            if (wId === workerId) continue;
            if (queue.length > maxDepth) {
                maxDepth = queue.length;
                busiestWorker = wId;
            }
        }

        if (busiestWorker && maxDepth > 0) {
            const targetQueue = this.workerQueues.get(busiestWorker)!;
            // Steal from tail of victim queue
            const stolenTask = targetQueue.pop();
            if (stolenTask) {
                stolenTask.stolenByWorkerId = workerId;
                const stealerStat = this.stats.get(workerId)!;
                stealerStat.stolen++;
                stealerStat.executed++;

                const victimStat = this.stats.get(busiestWorker)!;
                victimStat.surrendered++;

                return {
                    task: stolenTask,
                    wasStolen: true,
                    stolenFrom: busiestWorker
                };
            }
        }

        return { wasStolen: false };
    }

    getStats(): Record<string, { queueDepth: number; executed: number; stolen: number; surrendered: number }> {
        const res: Record<string, { queueDepth: number; executed: number; stolen: number; surrendered: number }> = {};
        for (const [wId, q] of this.workerQueues.entries()) {
            const s = this.stats.get(wId) || { executed: 0, stolen: 0, surrendered: 0 };
            res[wId] = {
                queueDepth: q.length,
                executed: s.executed,
                stolen: s.stolen,
                surrendered: s.surrendered
            };
        }
        return res;
    }

    clear(): void {
        for (const q of this.workerQueues.values()) {
            q.length = 0;
        }
        for (const s of this.stats.values()) {
            s.executed = 0;
            s.stolen = 0;
            s.surrendered = 0;
        }
    }
}

/**
 * Adaptive Task Scheduler.
 * Orchestrates multi-priority scheduling, rate-limit backpressure, work-stealing,
 * and predictive latency dispatch across heterogeneous agents and providers.
 */
export class AdaptiveTaskScheduler {
    private priorityQueue: PriorityTaskQueue;
    private rateLimiter: TokenBucketRateLimiter;
    private latencyModel: PredictiveLatencyModel;
    private workStealingPool: WorkStealingPool;
    private strategy: SchedulingStrategy;
    private maxConcurrency: number;
    private enableRateLimiting: boolean;
    private onEvent?: (event: SchedulerTelemetryEvent) => void;

    constructor(config?: SchedulerConfig) {
        this.strategy = config?.strategy ?? 'work-stealing';
        this.maxConcurrency = config?.maxConcurrency ?? 5;
        this.enableRateLimiting = config?.enableRateLimiting ?? true;
        this.onEvent = config?.onEvent;

        this.priorityQueue = new PriorityTaskQueue(config?.agingThresholdMs ?? 5000);
        this.rateLimiter = new TokenBucketRateLimiter(config?.rateLimits);
        this.latencyModel = new PredictiveLatencyModel();
        this.workStealingPool = new WorkStealingPool();
    }

    getRateLimiter(): TokenBucketRateLimiter {
        return this.rateLimiter;
    }

    getLatencyModel(): PredictiveLatencyModel {
        return this.latencyModel;
    }

    getWorkStealingPool(): WorkStealingPool {
        return this.workStealingPool;
    }

    getPriorityQueue(): PriorityTaskQueue {
        return this.priorityQueue;
    }

    setStrategy(strategy: SchedulingStrategy): void {
        this.strategy = strategy;
    }

    private emit(event: Omit<SchedulerTelemetryEvent, 'timestamp'>): void {
        if (this.onEvent) {
            try {
                this.onEvent({
                    ...event,
                    timestamp: Date.now()
                });
            } catch {
                // Ignore telemetry emission errors
            }
        }
    }

    /**
     * Executes an array of scheduled tasks according to the configured scheduling strategy,
     * applying rate-limit backpressure and work-stealing when enabled.
     */
    async executeScheduled<T = any, R = any>(
        tasks: Array<ScheduledTask<T, R>>,
        options?: {
            strategy?: SchedulingStrategy;
            maxConcurrency?: number;
            onProgress?: (completed: number, total: number) => void;
        }
    ): Promise<SchedulerExecutionResult<R>> {
        const strategy = options?.strategy ?? this.strategy;
        const maxConcurrency = Math.max(1, options?.maxConcurrency ?? this.maxConcurrency);
        const startTime = Date.now();

        const results: Array<TaskExecutionSummary<R>> = [];
        let totalQueueWaitMs = 0;
        let totalExecutionMs = 0;
        let totalBackpressureDelayMs = 0;
        let stolenTaskCount = 0;

        if (tasks.length === 0) {
            return {
                results: [],
                totalTasks: 0,
                successfulTasks: 0,
                failedTasks: 0,
                totalQueueWaitMs: 0,
                averageQueueWaitMs: 0,
                totalExecutionMs: 0,
                totalBackpressureDelayMs: 0,
                stolenTaskCount: 0
            };
        }

        // Initialize tasks with predictive durations
        for (const t of tasks) {
            t.createdAt = t.createdAt ?? Date.now();
            t.estimatedTokens = t.estimatedTokens ?? 250;
            t.estimatedDurationMs = t.estimatedDurationMs ?? this.latencyModel.predictDurationMs(t.domain, t.targetProvider, t.estimatedTokens);
            this.emit({
                type: 'task_scheduled',
                taskId: t.id,
                workerId: t.assignedWorkerId,
                provider: t.targetProvider,
                priority: t.priority
            });
        }

        if (strategy === 'work-stealing') {
            // Work-stealing implementation
            this.workStealingPool.clear();

            // Distribute tasks to worker local queues
            for (const t of tasks) {
                const worker = t.assignedWorkerId || 'default-worker';
                this.workStealingPool.submitTask(worker, t);
            }

            const registeredWorkers = this.workStealingPool.getRegisteredWorkers();
            const totalTasks = tasks.length;
            let completedCount = 0;

            const executeWorkerLoop = async (workerId: string) => {
                while (this.workStealingPool.getTotalPending() > 0) {
                    const polled = this.workStealingPool.pollNextTask(workerId);
                    if (!polled.task) {
                        break;
                    }

                    const task = polled.task;
                    const queueWaitMs = Math.max(0, Date.now() - (task.createdAt ?? Date.now()));
                    totalQueueWaitMs += queueWaitMs;

                    if (polled.wasStolen) {
                        stolenTaskCount++;
                        this.emit({
                            type: 'work_stolen',
                            taskId: task.id,
                            workerId,
                            metadata: { stolenFrom: polled.stolenFrom }
                        });
                    }

                    // Rate-limit check & backpressure delay
                    let backpressureDelayMs = 0;
                    if (this.enableRateLimiting && task.targetProvider) {
                        backpressureDelayMs = this.rateLimiter.getDelayUntilAvailable(task.targetProvider, task.estimatedTokens);
                        if (backpressureDelayMs > 0) {
                            totalBackpressureDelayMs += backpressureDelayMs;
                            this.emit({
                                type: 'backpressure_delay',
                                taskId: task.id,
                                provider: task.targetProvider,
                                delayMs: backpressureDelayMs
                            });
                            await new Promise(resolve => setTimeout(resolve, backpressureDelayMs));
                        }
                        this.rateLimiter.acquire(task.targetProvider, task.estimatedTokens);
                    }

                    task.startedAt = Date.now();
                    this.emit({
                        type: 'task_started',
                        taskId: task.id,
                        workerId,
                        provider: task.targetProvider
                    });

                    let executionResult: R | undefined;
                    let executionError: Error | undefined;
                    let isSuccess = true;

                    try {
                        executionResult = await task.execute(task);
                    } catch (err: any) {
                        isSuccess = false;
                        executionError = err instanceof Error ? err : new Error(String(err));
                    }

                    task.completedAt = Date.now();
                    const durationMs = task.completedAt - task.startedAt;
                    totalExecutionMs += durationMs;

                    this.latencyModel.recordCompletion(task.domain, task.targetProvider, task.estimatedTokens ?? 200, durationMs);

                    this.emit({
                        type: isSuccess ? 'task_completed' : 'task_failed',
                        taskId: task.id,
                        workerId,
                        provider: task.targetProvider,
                        durationMs,
                        metadata: { success: isSuccess, error: executionError?.message }
                    });

                    results.push({
                        taskId: task.id,
                        workerId,
                        result: executionResult,
                        error: executionError,
                        success: isSuccess,
                        queueWaitMs,
                        executionMs: durationMs,
                        backpressureDelayMs,
                        wasStolen: polled.wasStolen,
                        stolenFrom: polled.stolenFrom
                    });

                    completedCount++;
                    if (options?.onProgress) {
                        options.onProgress(completedCount, totalTasks);
                    }
                }
            };

            // Run workers concurrently up to maxConcurrency
            const workerPool = registeredWorkers.slice(0, maxConcurrency);
            // If fewer registered workers than maxConcurrency, supplement with workers
            while (workerPool.length < Math.min(maxConcurrency, totalTasks)) {
                workerPool.push(`worker-${workerPool.length + 1}`);
            }

            await Promise.all(workerPool.map(wId => executeWorkerLoop(wId)));

        } else {
            // Queue-based strategies (priority, shortest-job-first, least-loaded, fair-share)
            let orderedTasks: Array<ScheduledTask<T, R>> = [...tasks];

            if (strategy === 'shortest-job-first') {
                orderedTasks.sort((a, b) => (a.estimatedDurationMs ?? 400) - (b.estimatedDurationMs ?? 400));
            } else if (strategy === 'priority') {
                this.priorityQueue.clear();
                this.priorityQueue.enqueueBatch(orderedTasks);
                orderedTasks = [];
                while (!this.priorityQueue.isEmpty()) {
                    orderedTasks.push(this.priorityQueue.dequeue()!);
                }
            } else if (strategy === 'fair-share') {
                // Interleave tasks from different assigned workers / domains
                const grouped: Map<string, Array<ScheduledTask<T, R>>> = new Map();
                for (const t of orderedTasks) {
                    const groupKey = t.assignedWorkerId || t.domain || 'default';
                    if (!grouped.has(groupKey)) grouped.set(groupKey, []);
                    grouped.get(groupKey)!.push(t);
                }
                orderedTasks = [];
                let hasRemaining = true;
                while (hasRemaining) {
                    hasRemaining = false;
                    for (const group of grouped.values()) {
                        if (group.length > 0) {
                            orderedTasks.push(group.shift()!);
                            if (group.length > 0) hasRemaining = true;
                        }
                    }
                }
            }

            // Execute ordered tasks with concurrency window
            const inFlight = new Set<Promise<void>>();
            let completedCount = 0;
            const totalTasks = orderedTasks.length;

            for (const task of orderedTasks) {
                const workerId = task.assignedWorkerId || 'default-worker';

                const runTask = async () => {
                    const queueWaitMs = Math.max(0, Date.now() - (task.createdAt ?? Date.now()));
                    totalQueueWaitMs += queueWaitMs;

                    let backpressureDelayMs = 0;
                    if (this.enableRateLimiting && task.targetProvider) {
                        backpressureDelayMs = this.rateLimiter.getDelayUntilAvailable(task.targetProvider, task.estimatedTokens);
                        if (backpressureDelayMs > 0) {
                            totalBackpressureDelayMs += backpressureDelayMs;
                            this.emit({
                                type: 'backpressure_delay',
                                taskId: task.id,
                                provider: task.targetProvider,
                                delayMs: backpressureDelayMs
                            });
                            await new Promise(resolve => setTimeout(resolve, backpressureDelayMs));
                        }
                        this.rateLimiter.acquire(task.targetProvider, task.estimatedTokens);
                    }

                    task.startedAt = Date.now();
                    this.emit({
                        type: 'task_started',
                        taskId: task.id,
                        workerId,
                        provider: task.targetProvider
                    });

                    let executionResult: R | undefined;
                    let executionError: Error | undefined;
                    let isSuccess = true;

                    try {
                        executionResult = await task.execute(task);
                    } catch (err: any) {
                        isSuccess = false;
                        executionError = err instanceof Error ? err : new Error(String(err));
                    }

                    task.completedAt = Date.now();
                    const durationMs = task.completedAt - task.startedAt;
                    totalExecutionMs += durationMs;

                    this.latencyModel.recordCompletion(task.domain, task.targetProvider, task.estimatedTokens ?? 200, durationMs);

                    this.emit({
                        type: isSuccess ? 'task_completed' : 'task_failed',
                        taskId: task.id,
                        workerId,
                        provider: task.targetProvider,
                        durationMs,
                        metadata: { success: isSuccess, error: executionError?.message }
                    });

                    results.push({
                        taskId: task.id,
                        workerId,
                        result: executionResult,
                        error: executionError,
                        success: isSuccess,
                        queueWaitMs,
                        executionMs: durationMs,
                        backpressureDelayMs,
                        wasStolen: false
                    });

                    completedCount++;
                    if (options?.onProgress) {
                        options.onProgress(completedCount, totalTasks);
                    }
                };

                const p = runTask().finally(() => inFlight.delete(p));
                inFlight.add(p);

                if (inFlight.size >= maxConcurrency) {
                    await Promise.race(inFlight);
                }
            }

            await Promise.all(inFlight);
        }

        const successfulTasks = results.filter(r => r.success).length;
        const failedTasks = results.filter(r => !r.success).length;
        const averageQueueWaitMs = results.length > 0 ? Math.round(totalQueueWaitMs / results.length) : 0;

        return {
            results,
            totalTasks: results.length,
            successfulTasks,
            failedTasks,
            totalQueueWaitMs,
            averageQueueWaitMs,
            totalExecutionMs,
            totalBackpressureDelayMs,
            stolenTaskCount
        };
    }
}

export const globalTaskScheduler = new AdaptiveTaskScheduler();
