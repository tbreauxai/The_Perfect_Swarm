import { SubComputationCacheEntry, SubComputationCacheMetrics, SubComputationCacheConfig, BaselineDifference, TokenWeightReport, PreFilterOptions, PreFilterResult, PartialPrediction, EarlyExitOptions, EarlyExitDecision, PoolTask, WorkerPoolMetrics, PredictionWorkerPoolConfig, TieredPredictionInput, TieredPredictionResult, SubComputationDomain, PredictionTaskPriority } from "./types.ts";

/**
 * Prediction Worker Pool: Parallelizes independent prediction tasks across concurrent lanes.
 * Prevents execution stalls and scales throughput across available compute.
 */
export class PredictionWorkerPool {
    private maxConcurrency: number;
    private defaultTaskTimeoutMs: number;
    private queue: PoolTask[] = [];
    private queueOffset: number = 0;
    private activeWorkers: number = 0;
    private completedTasks: number = 0;
    private failedTasks: number = 0;
    private totalExecutionTimeMs: number = 0;
    private isShutdown: boolean = false;

    constructor(config: PredictionWorkerPoolConfig = {}) {
        this.maxConcurrency = config.maxConcurrency ?? 4;
        this.defaultTaskTimeoutMs = config.defaultTaskTimeoutMs ?? 180000;
    }

    public submit<T = any>(taskFn: () => Promise<T>, options: { id?: string; priority?: PredictionTaskPriority; timeoutMs?: number } = {}): Promise<T> {
        if (this.isShutdown) {
            return Promise.reject(new Error('PredictionWorkerPool is shut down'));
        }

        return new Promise<T>((resolve, reject) => {
            const task: PoolTask<T> = {
                id: options.id || `task-${Date.now()}-${crypto.randomUUID()}`,
                priority: options.priority || 'normal',
                execute: taskFn,
                resolve,
                reject,
                timeoutMs: options.timeoutMs ?? this.defaultTaskTimeoutMs,
                submittedAt: Date.now()
            };

            if (task.priority === 'high') {
                let firstNonHighIdx = -1;
                for (let i = this.queueOffset; i < this.queue.length; i++) {
                    if (this.queue[i].priority !== 'high') {
                        firstNonHighIdx = i;
                        break;
                    }
                }
                if (firstNonHighIdx === -1) {
                    this.queue.push(task);
                } else {
                    this.queue.splice(firstNonHighIdx, 0, task);
                }
            } else if (task.priority === 'low') {
                this.queue.push(task);
            } else {
                let firstLowIdx = -1;
                for (let i = this.queueOffset; i < this.queue.length; i++) {
                    if (this.queue[i].priority === 'low') {
                        firstLowIdx = i;
                        break;
                    }
                }
                if (firstLowIdx === -1) {
                    this.queue.push(task);
                } else {
                    this.queue.splice(firstLowIdx, 0, task);
                }
            }

            this.drainQueue();
        });
    }

    public async submitBatch<T = any>(taskFns: Array<() => Promise<T>>, options: { priority?: PredictionTaskPriority; timeoutMs?: number } = {}): Promise<T[]> {
        return Promise.all(taskFns.map((fn, idx) => this.submit(fn, { ...options, id: `batch-${idx}-${Date.now()}` })));
    }

    private drainQueue(): void {
        while (this.activeWorkers < this.maxConcurrency && this.queueOffset < this.queue.length) {
            const task = this.queue[this.queueOffset++];
            if (!task) break;

            if (this.queueOffset > 64 && this.queueOffset * 2 > this.queue.length) {
                this.queue = this.queue.slice(this.queueOffset);
                this.queueOffset = 0;
            }

            this.activeWorkers++;
            this.runTask(task);
        }
    }

    private async runTask(task: PoolTask): Promise<void> {
        const startTime = Date.now();
        let timer: any = null;
        const timeoutPromise = new Promise((_, reject) => {
                        if (task.timeoutMs && task.timeoutMs > 0) {
                            timer = setTimeout(() => {
                                reject(new Error(`[TIMEOUT] PredictionWorkerPool task '${task.id}' timed out after ${task.timeoutMs}ms`));
                            }, task.timeoutMs);
                        }
                    });
        try {
            const result = await Promise.race([task.execute(), timeoutPromise]);
            if (timer) clearTimeout(timer);
            const duration = Date.now() - startTime;
            this.completedTasks++;
            this.totalExecutionTimeMs += duration;
            task.resolve(result);
        } catch (err: any) {
            if (timer) clearTimeout(timer);
            this.failedTasks++;
            task.reject(err);
        } finally {
            this.activeWorkers--;
            this.drainQueue();
        }
    }

    public getStats(): WorkerPoolMetrics {
        return {
            maxConcurrency: this.maxConcurrency,
            activeWorkers: this.activeWorkers,
            queueLength: this.queue.length,
            completedTasks: this.completedTasks,
            failedTasks: this.failedTasks,
            totalExecutionTimeMs: this.totalExecutionTimeMs,
            averageTaskDurationMs: this.completedTasks > 0 ? Math.round(this.totalExecutionTimeMs / this.completedTasks) : 0
        };
    }

    public shutdown(): void {
        this.isShutdown = true;
        while (this.queue.length > 0) {
            const task = this.queue.shift();
            task?.reject(new Error('PredictionWorkerPool has been shut down'));
        }
    }
}
