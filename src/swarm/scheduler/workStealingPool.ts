import type { ScheduledTask } from './types.ts';

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
