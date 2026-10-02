import type {
    SchedulingStrategy,
    ScheduledTask,
    TaskExecutionSummary,
    SchedulerExecutionResult,
    SchedulerTelemetryEvent,
    SchedulerConfig
} from './types.ts';
import { PriorityTaskQueue } from './priorityQueue.ts';
import { TokenBucketRateLimiter } from './rateLimiter.ts';
import { PredictiveLatencyModel } from './latencyModel.ts';
import { WorkStealingPool } from './workStealingPool.ts';

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
