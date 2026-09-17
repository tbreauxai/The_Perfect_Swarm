# Ultragoal Brief: Speculative Parallel Execution with Conflict Resolution

## Objective
Enable speculative parallel execution with conflict resolution for independent subtasks and multi-chunk workloads across swarm agent pods to reduce end-to-end analysis latency by 40-60%.

## Background & Problem Statement
In multi-chunk and multi-subtask workloads, `src/swarm/engine.ts` currently processes chunks sequentially in a loop with artificial 2000ms delay between chunks to avoid rate-limits. This results in $O(N)$ serial latency ($N \times (\text{latency} + 2\text{s})$) even when chunks or subtasks are completely independent.

## Architecture Boundaries
1. **Speculative Execution Engine (`src/swarm/speculative.ts`)**:
   - `DependencyGraph`: Analyze subtask/chunk dependencies and determine parallel independence.
   - `SpeculativeExecutionCoordinator`: Concurrently dispatch independent chunk/subtask executions across specialists bounded by `NodeCapacityManager` concurrency slots.
   - `ConflictResolver`: Reconcile conflicting findings, overlapping anomaly claims, and contradictory metrics between concurrent speculative outputs using confidence weighting, source specialist reliability, and semantic deduplication.
2. **Swarm Engine Integration (`src/swarm/engine.ts`)**:
   - Support `settings.speculativeParallel` (default: true for multi-chunk tasks).
   - Concurrently execute independent chunks using `SpeculativeExecutionCoordinator`.
   - Pass parallel reports through `ConflictResolver` before cluster aggregation and manager synthesis.
   - Emit `Speculative Parallel Execution` and `Conflict Resolution` telemetry events with measured latency savings percentage.
3. **Distribution & Backward Compatibility**:
   - Zero external dependencies (pure TypeScript).
   - ESM/CJS exports in `dist/swarm` and `package.json`.
   - 100% passing tests across all unit and E2E suites.
