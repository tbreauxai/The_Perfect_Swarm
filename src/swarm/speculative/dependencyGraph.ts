import type { SubtaskNode, SubtaskStatus } from './types.ts';

/**
 * Directed Acyclic Graph (DAG) for subtask dependency modeling and batching.
 */
export class DependencyGraph<T = any> {
    private nodes: Map<string, SubtaskNode<T>> = new Map();
    private dependents: Map<string, Set<string>> = new Map(); // prerequisiteId -> dependentIds

    addNode(node: SubtaskNode<T>): void {
        this.nodes.set(node.id, {
            ...node,
            dependencies: [...node.dependencies],
            status: node.dependencies.length === 0 ? 'ready' : 'pending'
        });

        if (!this.dependents.has(node.id)) {
            this.dependents.set(node.id, new Set());
        }

        for (const depId of node.dependencies) {
            if (!this.dependents.has(depId)) {
                this.dependents.set(depId, new Set());
            }
            this.dependents.get(depId)!.add(node.id);
        }
    }

    addDependency(dependentId: string, prerequisiteId: string): void {
        const node = this.nodes.get(dependentId);
        if (!node) throw new Error(`Node ${dependentId} not found in graph`);
        if (!this.nodes.has(prerequisiteId)) throw new Error(`Prerequisite ${prerequisiteId} not found in graph`);

        if (!node.dependencies.includes(prerequisiteId)) {
            node.dependencies.push(prerequisiteId);
            if (node.status === 'ready') {
                node.status = 'pending';
            }
        }

        if (!this.dependents.has(prerequisiteId)) {
            this.dependents.set(prerequisiteId, new Set());
        }
        this.dependents.get(prerequisiteId)!.add(dependentId);

        if (this.hasCycles()) {
            // Revert dependency to maintain DAG invariant
            node.dependencies = node.dependencies.filter(id => id !== prerequisiteId);
            this.dependents.get(prerequisiteId)!.delete(dependentId);
            throw new Error(`Cycle detected when adding dependency from ${dependentId} to ${prerequisiteId}`);
        }
    }

    getNode(id: string): SubtaskNode<T> | undefined {
        return this.nodes.get(id);
    }

    getAllNodes(): SubtaskNode<T>[] {
        return Array.from(this.nodes.values());
    }

    getReadyNodes(): SubtaskNode<T>[] {
        return Array.from(this.nodes.values()).filter(n => n.status === 'ready');
    }

    markRunning(id: string): void {
        const node = this.nodes.get(id);
        if (node) node.status = 'running';
    }

    markCompleted(id: string, result: any, durationMs?: number): void {
        const node = this.nodes.get(id);
        if (!node) return;
        node.status = 'completed';
        node.result = result;
        if (durationMs !== undefined) node.durationMs = durationMs;

        // Check dependents and promote to ready if all prerequisites are completed
        const deps = this.dependents.get(id);
        if (deps) {
            for (const depId of deps) {
                const depNode = this.nodes.get(depId);
                if (depNode && depNode.status === 'pending') {
                    const allDone = depNode.dependencies.every(dId => {
                        const dNode = this.nodes.get(dId);
                        return dNode?.status === 'completed';
                    });
                    if (allDone) {
                        depNode.status = 'ready';
                    }
                }
            }
        }
    }

    markFailed(id: string, error: string): void {
        const node = this.nodes.get(id);
        if (!node) return;
        node.status = 'failed';
        node.error = error;
    }

    isComplete(): boolean {
        return Array.from(this.nodes.values()).every(n => n.status === 'completed' || n.status === 'failed');
    }

    hasCycles(): boolean {
        const visited = new Set<string>();
        const inStack = new Set<string>();

        const checkCycle = (nodeId: string): boolean => {
            visited.add(nodeId);
            inStack.add(nodeId);

            const children = this.dependents.get(nodeId) || new Set();
            for (const childId of children) {
                if (!visited.has(childId)) {
                    if (checkCycle(childId)) return true;
                } else if (inStack.has(childId)) {
                    return true;
                }
            }

            inStack.delete(nodeId);
            return false;
        };

        for (const nodeId of this.nodes.keys()) {
            if (!visited.has(nodeId)) {
                if (checkCycle(nodeId)) return true;
            }
        }

        return false;
    }

    /**
     * Topologically partitions graph into sequential execution stages,
     * where all nodes within each stage are completely independent and can execute concurrently.
     */
    getExecutionBatches(): SubtaskNode<T>[][] {
        const batches: SubtaskNode<T>[][] = [];
        const completedIds = new Set<string>();
        const remaining = new Map(this.nodes);

        while (remaining.size > 0) {
            const currentBatch: SubtaskNode<T>[] = [];
            for (const [id, node] of remaining) {
                const canExecute = node.dependencies.every(depId => completedIds.has(depId));
                if (canExecute) {
                    currentBatch.push(node);
                }
            }

            if (currentBatch.length === 0) {
                // Cycle or unresolvable dependency fallback
                currentBatch.push(...remaining.values());
                batches.push(currentBatch);
                break;
            }

            for (const node of currentBatch) {
                remaining.delete(node.id);
                completedIds.add(node.id);
            }
            batches.push(currentBatch);
        }

        return batches;
    }

    /**
     * Heuristic chunk dependency analyzer.
     * Detects sequential pipeline dependencies vs orthogonal/independent data shards.
     */
    static fromChunks(chunks: string[], task: string = ''): DependencyGraph<string> {
        const graph = new DependencyGraph<string>();
        const taskLower = task.toLowerCase();

        // Sequential indicators in task description
        const hasSequentialIntent = 
            taskLower.includes('step by step') ||
            taskLower.includes('pipeline') ||
            taskLower.includes('in sequence') ||
            taskLower.includes('subsequently') ||
            taskLower.includes('pass output of');

        for (let i = 0; i < chunks.length; i++) {
            const chunkText = chunks[i];
            const dependencies: string[] = [];

            // If task explicitly specifies pipeline ordering and not chunk 0
            if (hasSequentialIntent && i > 0) {
                dependencies.push(`chunk-${i - 1}`);
            }

            // Check if chunk text references prior chunks explicitly
            const chunkLower = chunkText.toLowerCase();
            if (i > 0 && (chunkLower.includes(`depends on chunk ${i}`) || chunkLower.includes(`after step ${i}`))) {
                dependencies.push(`chunk-${i - 1}`);
            }

            graph.addNode({
                id: `chunk-${i}`,
                chunkIndex: i,
                dependencies: Array.from(new Set(dependencies)),
                payload: chunkText,
                status: dependencies.length === 0 ? 'ready' : 'pending'
            });
        }

        return graph;
    }
}
