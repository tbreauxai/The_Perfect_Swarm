import type {
    SpeculativeTask,
    SpeculativeExecutionResult,
    SpeculativeOptions
} from './types.ts';
import { DependencyGraph } from './dependencyGraph.ts';
import { ConflictResolver } from './conflictResolver.ts';

/**
 * Coordinates speculative parallel execution of independent subtasks,
 * bounding concurrency, tracking wall-clock speedup, and applying conflict resolution.
 */
export class SpeculativeExecutionCoordinator {
    private conflictResolver: ConflictResolver;

    constructor(conflictResolver?: ConflictResolver) {
        this.conflictResolver = conflictResolver || new ConflictResolver();
    }

    /**
     * Executes independent tasks concurrently according to their dependency graph.
     */
    async executeSpeculative<TInput, TOutput>(
        tasks: SpeculativeTask<TInput, TOutput>[],
        options?: SpeculativeOptions
    ): Promise<SpeculativeExecutionResult<TOutput>> {
        const startTime = Date.now();
        const maxConcurrency = Math.max(1, options?.maxConcurrency ?? 4);
        const staggerDelayMs = options?.staggerDelayMs ?? 20;

        if (tasks.length === 0) {
            return {
                results: [],
                reconciledReport: this.conflictResolver.reconcileReports([]),
                serialDurationEstimateMs: 0,
                actualWallClockDurationMs: 0,
                latencyReductionPercent: 0,
                concurrencyPeak: 0,
                totalTasks: 0
            };
        }

        // Build dependency graph
        const graph = new DependencyGraph<SpeculativeTask<TInput, TOutput>>();
        for (const t of tasks) {
            graph.addNode({
                id: t.id,
                chunkIndex: t.chunkIndex,
                dependencies: t.dependencies || [],
                payload: t,
                status: (t.dependencies && t.dependencies.length > 0) ? 'pending' : 'ready'
            });
        }

        const stages = graph.getExecutionBatches();
        const executionOutputs: (TOutput & { _chunkIndex?: number })[] = [];
        let accumulatedSerialDurationMs = 0;
        let peakActive = 0;
        let currentlyActive = 0;

        for (let s = 0; s < stages.length; s++) {
            const stageNodes = stages[s];

            // Execute nodes in the current stage with bounded concurrency
            const executingPromises: Promise<void>[] = [];
            const queue = [...stageNodes];

            const worker = async () => {
                while (queue.length > 0) {
                    const node = queue.shift();
                    if (!node) break;

                    currentlyActive++;
                    if (currentlyActive > peakActive) {
                        peakActive = currentlyActive;
                    }

                    const taskStart = Date.now();
                    try {
                        graph.markRunning(node.id);
                        const output = await node.payload.execute();
                        const taskDuration = Date.now() - taskStart;
                        accumulatedSerialDurationMs += taskDuration;

                        const enrichedOutput = {
                            ...(output as any),
                            _chunkIndex: node.chunkIndex
                        };
                        executionOutputs.push(enrichedOutput);
                        graph.markCompleted(node.id, enrichedOutput, taskDuration);
                    } catch (err: any) {
                        const taskDuration = Date.now() - taskStart;
                        accumulatedSerialDurationMs += taskDuration;
                        graph.markFailed(node.id, err.message || String(err));
                        throw err;
                    } finally {
                        currentlyActive--;
                    }

                    if (staggerDelayMs > 0 && queue.length > 0) {
                        await new Promise(resolve => setTimeout(resolve, staggerDelayMs));
                    }
                }
            };

            const numWorkers = Math.min(queue.length, maxConcurrency);
            for (let w = 0; w < numWorkers; w++) {
                executingPromises.push(worker());
            }

            await Promise.all(executingPromises);
        }

        const actualWallClockDurationMs = Math.max(1, Date.now() - startTime);

        // Serial estimate includes task execution time + legacy 2000ms sequential batch delay between chunks
        const legacySequentialDelayMs = Math.max(0, tasks.length - 1) * 2000;
        const serialDurationEstimateMs = accumulatedSerialDurationMs + legacySequentialDelayMs;

        // Calculate latency reduction vs serial execution
        const latencyReductionPercent = serialDurationEstimateMs > actualWallClockDurationMs
            ? Math.round(((serialDurationEstimateMs - actualWallClockDurationMs) / serialDurationEstimateMs) * 100)
            : 0;

        // Sort outputs by chunk index
        executionOutputs.sort((a, b) => ((a as any)._chunkIndex ?? 0) - ((b as any)._chunkIndex ?? 0));

        // Reconcile parallel outputs for conflicts & deduplication
        const reconciledReport = this.conflictResolver.reconcileReports(executionOutputs, options?.conflictOptions);

        return {
            results: executionOutputs,
            reconciledReport,
            serialDurationEstimateMs,
            actualWallClockDurationMs,
            latencyReductionPercent,
            concurrencyPeak: peakActive,
            totalTasks: tasks.length
        };
    }
}
