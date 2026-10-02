import type { TaskPriority, ScheduledTask } from './types.ts';

export const PRIORITY_SCORES: Record<TaskPriority, number> = {
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
    private queueOffset: number = 0;
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
        if (this.isEmpty()) return undefined;
        this.sortQueue();
        const task = this.queue[this.queueOffset++];

        // Slice to prevent memory leak when offset gets too large
        if (this.queueOffset > 64 && this.queueOffset * 2 > this.queue.length) {
            this.queue = this.queue.slice(this.queueOffset);
            this.queueOffset = 0;
        }

        return task;
    }

    peek(): ScheduledTask<T, R> | undefined {
        if (this.isEmpty()) return undefined;
        this.sortQueue();
        return this.queue[this.queueOffset];
    }

    size(): number {
        return this.queue.length - this.queueOffset;
    }

    isEmpty(): boolean {
        return this.queue.length - this.queueOffset === 0;
    }

    remove(taskId: string): boolean {
        for (let i = this.queueOffset; i < this.queue.length; i++) {
            if (this.queue[i].id === taskId) {
                this.queue.splice(i, 1);
                return true;
            }
        }
        return false;
    }

    clear(): void {
        this.queue = [];
        this.queueOffset = 0;
    }

    getAll(): Array<ScheduledTask<T, R>> {
        return this.queue.slice(this.queueOffset);
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

        // If there's an offset, we must clear dead elements before sorting
        // otherwise they mix back into the active priority pool
        if (this.queueOffset > 0) {
            this.queue = this.queue.slice(this.queueOffset);
            this.queueOffset = 0;
        }

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
