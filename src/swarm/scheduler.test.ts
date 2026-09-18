import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    PriorityTaskQueue,
    TokenBucketRateLimiter,
    PredictiveLatencyModel,
    WorkStealingPool,
    AdaptiveTaskScheduler,
    ScheduledTask,
    SchedulerTelemetryEvent
} from './scheduler.ts';

describe('AdaptiveTaskScheduler Unit Test Suite', () => {
    describe('PriorityTaskQueue', () => {
        let queue: PriorityTaskQueue;

        beforeEach(() => {
            queue = new PriorityTaskQueue(2000); // 2s aging threshold
        });

        it('dequeues tasks strictly in priority order', () => {
            const now = Date.now();
            queue.enqueue({ id: 't-normal', priority: 'normal', createdAt: now, execute: async () => 'normal' });
            queue.enqueue({ id: 't-background', priority: 'background', createdAt: now, execute: async () => 'bg' });
            queue.enqueue({ id: 't-urgent', priority: 'urgent', createdAt: now, execute: async () => 'urgent' });
            queue.enqueue({ id: 't-high', priority: 'high', createdAt: now, execute: async () => 'high' });

            expect(queue.size()).toBe(4);
            expect(queue.dequeue()?.id).toBe('t-urgent');
            expect(queue.dequeue()?.id).toBe('t-high');
            expect(queue.dequeue()?.id).toBe('t-normal');
            expect(queue.dequeue()?.id).toBe('t-background');
            expect(queue.isEmpty()).toBe(true);
        });

        it('preserves FIFO ordering for identical priority tasks', () => {
            const base = 1000000;
            queue.enqueue({ id: 't1', priority: 'high', createdAt: base + 10, execute: async () => 1 });
            queue.enqueue({ id: 't2', priority: 'high', createdAt: base + 5, execute: async () => 2 });
            queue.enqueue({ id: 't3', priority: 'high', createdAt: base + 20, execute: async () => 3 });

            expect(queue.dequeue()?.id).toBe('t2'); // earliest createdAt
            expect(queue.dequeue()?.id).toBe('t1');
            expect(queue.dequeue()?.id).toBe('t3');
        });

        it('elevates priority of aged tasks to prevent starvation', () => {
            const now = Date.now();
            // Old normal task created 3 aging intervals ago (+30 score: 20 + 30 = 50)
            queue.enqueue({ id: 'old-normal', priority: 'normal', createdAt: now - 6500, execute: async () => 'old' });
            // Brand new normal task (score 20)
            queue.enqueue({ id: 'new-normal', priority: 'normal', createdAt: now, execute: async () => 'new' });

            expect(queue.dequeue()?.id).toBe('old-normal');
            expect(queue.dequeue()?.id).toBe('new-normal');
        });

        it('supports remove, peek, and clear operations', () => {
            queue.enqueue({ id: 'a', priority: 'normal', execute: async () => 'a' });
            queue.enqueue({ id: 'b', priority: 'urgent', execute: async () => 'b' });

            expect(queue.peek()?.id).toBe('b');
            expect(queue.remove('a')).toBe(true);
            expect(queue.size()).toBe(1);
            expect(queue.remove('non-existent')).toBe(false);

            queue.clear();
            expect(queue.isEmpty()).toBe(true);
        });
    });

    describe('TokenBucketRateLimiter', () => {
        let limiter: TokenBucketRateLimiter;

        beforeEach(() => {
            limiter = new TokenBucketRateLimiter({
                testprov: { maxRpm: 12, maxTpm: 600 } // 12 req/min (1 every 5s), 600 tok/min (10 tok/s)
            });
        });

        it('allows acquisitions within burst limits', () => {
            const can1 = limiter.canAcquire('testprov', 100);
            expect(can1).toBe(true);

            const acq1 = limiter.acquire('testprov', 100);
            expect(acq1).toBe(true);
            expect(limiter.getDelayUntilAvailable('testprov', 100)).toBe(0);
        });

        it('calculates delay when request or token bucket is exhausted', () => {
            const profile = limiter.getProfile('testprov');
            expect(profile.maxRpm).toBe(12);

            // Exhaust all 12 requests
            for (let i = 0; i < 12; i++) {
                limiter.acquire('testprov', 10);
            }

            // 13th request should require backpressure delay
            const delay = limiter.getDelayUntilAvailable('testprov', 10);
            expect(delay).toBeGreaterThan(0);
            expect(limiter.canAcquire('testprov', 10)).toBe(false);
            expect(limiter.acquire('testprov', 10)).toBe(false);
        });

        it('replenishes capacity smoothly over elapsed time', () => {
            const now = Date.now();
            // Exhaust requests at `now`
            for (let i = 0; i < 12; i++) {
                limiter.acquire('testprov', 10, now);
            }

            expect(limiter.canAcquire('testprov', 10, now)).toBe(false);

            // After 10 seconds (10000ms), 12 * (10000/60000) = 2 requests replenished
            const future = now + 10000;
            expect(limiter.canAcquire('testprov', 10, future)).toBe(true);
            expect(limiter.acquire('testprov', 10, future)).toBe(true);
        });
    });

    describe('PredictiveLatencyModel', () => {
        let model: PredictiveLatencyModel;

        beforeEach(() => {
            model = new PredictiveLatencyModel(0.5, 0.2); // alpha = 0.5, 0.2ms per token
        });

        it('returns baseline prediction when no prior observations exist', () => {
            const predicted = model.predictDurationMs('security', 'groq', 500);
            // Default baseline 400 + (500 * 0.2) = 500ms
            expect(predicted).toBe(500);
        });

        it('updates EWMA prediction following observed execution times', () => {
            // First observation: 200ms
            model.recordCompletion('security', 'groq', 100, 200);

            // Base latency should now be 200ms. For 100 tokens: 200 + (100 * 0.2) = 220ms
            const p1 = model.predictDurationMs('security', 'groq', 100);
            expect(p1).toBe(220);

            // Second observation: 400ms (EWMA: 0.5*400 + 0.5*200 = 300ms)
            model.recordCompletion('security', 'groq', 100, 400);
            const p2 = model.predictDurationMs('security', 'groq', 100);
            expect(p2).toBe(320); // 300 + 20
        });
    });

    describe('WorkStealingPool', () => {
        let pool: WorkStealingPool;

        beforeEach(() => {
            pool = new WorkStealingPool();
            pool.registerWorker('worker-A');
            pool.registerWorker('worker-B');
        });

        it('worker consumes local queue without stealing when tasks are available', () => {
            pool.submitTask('worker-A', { id: 'a1', execute: async () => 'a1' });
            pool.submitTask('worker-A', { id: 'a2', execute: async () => 'a2' });

            const poll1 = pool.pollNextTask('worker-A');
            expect(poll1.wasStolen).toBe(false);
            expect(poll1.task?.id).toBe('a1');

            const poll2 = pool.pollNextTask('worker-A');
            expect(poll2.wasStolen).toBe(false);
            expect(poll2.task?.id).toBe('a2');
        });

        it('idle worker steals tasks from overloaded worker', () => {
            // Worker-A receives 3 tasks, Worker-B has 0
            pool.submitTask('worker-A', { id: 'a1', execute: async () => 'a1' });
            pool.submitTask('worker-A', { id: 'a2', execute: async () => 'a2' });
            pool.submitTask('worker-A', { id: 'a3', execute: async () => 'a3' });

            expect(pool.getQueueDepth('worker-A')).toBe(3);
            expect(pool.getQueueDepth('worker-B')).toBe(0);

            // Worker-B polls and should steal the tail task ('a3') from Worker-A
            const pollB = pool.pollNextTask('worker-B');
            expect(pollB.wasStolen).toBe(true);
            expect(pollB.stolenFrom).toBe('worker-A');
            expect(pollB.task?.id).toBe('a3');
            expect(pollB.task?.stolenByWorkerId).toBe('worker-B');

            // Worker-A now has 2 tasks remaining
            expect(pool.getQueueDepth('worker-A')).toBe(2);

            const stats = pool.getStats();
            expect(stats['worker-B'].stolen).toBe(1);
            expect(stats['worker-A'].surrendered).toBe(1);
        });

        it('returns empty when all queues are drained', () => {
            const poll = pool.pollNextTask('worker-A');
            expect(poll.task).toBeUndefined();
            expect(poll.wasStolen).toBe(false);
        });
    });

    describe('AdaptiveTaskScheduler Execution', () => {
        it('executes tasks using work-stealing across multiple workers', async () => {
            const scheduler = new AdaptiveTaskScheduler({
                strategy: 'work-stealing',
                maxConcurrency: 3,
                enableRateLimiting: false
            });

            const tasks: Array<ScheduledTask> = [
                { id: 't1', assignedWorkerId: 'spec-1', execute: async () => 'res-1' },
                { id: 't2', assignedWorkerId: 'spec-1', execute: async () => 'res-2' },
                { id: 't3', assignedWorkerId: 'spec-1', execute: async () => 'res-3' },
                { id: 't4', assignedWorkerId: 'spec-2', execute: async () => 'res-4' }
            ];

            const res = await scheduler.executeScheduled(tasks);
            expect(res.totalTasks).toBe(4);
            expect(res.successfulTasks).toBe(4);
            expect(res.failedTasks).toBe(0);
            expect(res.results.length).toBe(4);
            expect(res.results.map(r => r.result).sort()).toEqual(['res-1', 'res-2', 'res-3', 'res-4']);
        });

        it('executes tasks in strict priority order', async () => {
            const executionOrder: string[] = [];
            const scheduler = new AdaptiveTaskScheduler({
                strategy: 'priority',
                maxConcurrency: 1, // Sequential to verify strict order
                enableRateLimiting: false
            });

            const tasks: Array<ScheduledTask> = [
                { id: 'p-normal', priority: 'normal', execute: async () => { executionOrder.push('normal'); } },
                { id: 'p-urgent', priority: 'urgent', execute: async () => { executionOrder.push('urgent'); } },
                { id: 'p-background', priority: 'background', execute: async () => { executionOrder.push('background'); } },
                { id: 'p-high', priority: 'high', execute: async () => { executionOrder.push('high'); } }
            ];

            const res = await scheduler.executeScheduled(tasks);
            expect(res.successfulTasks).toBe(4);
            expect(executionOrder).toEqual(['urgent', 'high', 'normal', 'background']);
        });

        it('executes tasks in shortest-job-first (SJF) order', async () => {
            const executionOrder: string[] = [];
            const scheduler = new AdaptiveTaskScheduler({
                strategy: 'shortest-job-first',
                maxConcurrency: 1,
                enableRateLimiting: false
            });

            const tasks: Array<ScheduledTask> = [
                { id: 'long-task', estimatedDurationMs: 800, execute: async () => { executionOrder.push('long'); } },
                { id: 'short-task', estimatedDurationMs: 100, execute: async () => { executionOrder.push('short'); } },
                { id: 'medium-task', estimatedDurationMs: 350, execute: async () => { executionOrder.push('medium'); } }
            ];

            await scheduler.executeScheduled(tasks);
            expect(executionOrder).toEqual(['short', 'medium', 'long']);
        });

        it('executes tasks with fair-share interleaving across domains', async () => {
            const executionOrder: string[] = [];
            const scheduler = new AdaptiveTaskScheduler({
                strategy: 'fair-share',
                maxConcurrency: 1,
                enableRateLimiting: false
            });

            const tasks: Array<ScheduledTask> = [
                { id: 'd1-a', domain: 'database', execute: async () => { executionOrder.push('db-a'); } },
                { id: 'd1-b', domain: 'database', execute: async () => { executionOrder.push('db-b'); } },
                { id: 'd2-a', domain: 'security', execute: async () => { executionOrder.push('sec-a'); } },
                { id: 'd2-b', domain: 'security', execute: async () => { executionOrder.push('sec-b'); } }
            ];

            await scheduler.executeScheduled(tasks);
            // Should interleave database and security
            expect(executionOrder[0].startsWith('db')).toBe(true);
            expect(executionOrder[1].startsWith('sec')).toBe(true);
            expect(executionOrder[2].startsWith('db')).toBe(true);
            expect(executionOrder[3].startsWith('sec')).toBe(true);
        });

        it('handles task execution errors gracefully', async () => {
            const scheduler = new AdaptiveTaskScheduler({ enableRateLimiting: false });
            const tasks: Array<ScheduledTask> = [
                { id: 'ok-1', execute: async () => 'success' },
                { id: 'fail-1', execute: async () => { throw new Error('Simulated specialist failure'); } }
            ];

            const res = await scheduler.executeScheduled(tasks);
            expect(res.totalTasks).toBe(2);
            expect(res.successfulTasks).toBe(1);
            expect(res.failedTasks).toBe(1);

            const failedItem = res.results.find(r => r.taskId === 'fail-1');
            expect(failedItem?.success).toBe(false);
            expect(failedItem?.error?.message).toContain('Simulated specialist failure');
        });

        it('emits telemetry events during scheduled execution', async () => {
            const events: SchedulerTelemetryEvent[] = [];
            const scheduler = new AdaptiveTaskScheduler({
                enableRateLimiting: false,
                onEvent: (evt) => events.push(evt)
            });

            await scheduler.executeScheduled([
                { id: 'telemetry-task', priority: 'high', execute: async () => 'done' }
            ]);

            expect(events.some(e => e.type === 'task_scheduled')).toBe(true);
            expect(events.some(e => e.type === 'task_started')).toBe(true);
            expect(events.some(e => e.type === 'task_completed')).toBe(true);
        });
    });
});
