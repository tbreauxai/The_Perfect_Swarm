# Ultragoal Brief: Adaptive Load-Balancing & Task-Scheduling for Optimal Resource Allocation

## Objective
Introduce adaptive load-balancing and task-scheduling across swarm specialist nodes and model providers to achieve optimal resource allocation, eliminate rate-limit (429) bottlenecks, minimize tail latency, and enable priority-aware work-stealing.

## Background & Problem Statement
As swarm workflows execute larger payloads with parallel specialists:
1. Free-tier and rate-constrained LLM providers (e.g. Groq 30 RPM, Mistral, GitHub Models) suffer from burst exhaustion when multiple specialist tasks dispatch concurrently.
2. Static or simple Promise.all dispatches cause queue head-of-line blocking where slow or stalled specialists delay the entire synthesis phase.
3. Heterogeneous subtask complexities create imbalanced worker loads where fast analysts finish early while overloaded analysts remain saturated.
4. Without predictive latency modeling and priority queueing, critical-path analytical tasks are treated with the same urgency as background telemetry or non-blocking summaries.

## Architecture Boundaries
1. **Adaptive Task Scheduler (`src/swarm/scheduler.ts`)**:
   - `AdaptiveTaskScheduler`: Priority-queued task scheduling (`urgent`, `high`, `normal`, `background`) with preemption/reordering.
   - `SchedulingStrategy`: Pluggable strategies (`priority`, `fair-share`, `least-loaded`, `shortest-job-first`, `work-stealing`).
   - `TokenBucketRateLimiter`: Token bucket and sliding window rate limiter tracking RPM and TPM per provider with automatic backpressure pacing.
   - `WorkStealingPool`: Per-worker queues allowing idle specialist agents to steal pending tasks from saturated queues.
   - `PredictiveLatencyModel`: Exponential Weighted Moving Average (EWMA) latency and execution time predictor by domain and complexity.
2. **Swarm Engine Integration (`src/swarm/engine.ts` & `src/swarm/types.ts`)**:
   - Add `SwarmSchedulingSettings` to `SwarmEngineSettings`.
   - Dispatch analyst subtasks (Step 4) and speculative tasks through `AdaptiveTaskScheduler`.
   - Emit telemetry events: `Task Scheduled`, `Work Stolen`, `Queue Backpressure Delayed`.
   - Record scheduling metrics (queueWaitMs, executionMs, workStolenCount, backpressureWaitMs) in `SwarmWorkflowResult`.
3. **Distribution & Backward Compatibility**:
   - Zero external runtime dependencies (pure TypeScript algorithmic scheduler).
   - Subpath export `@perfect-swarm/core/scheduler`.
   - Dual ESM/CJS distribution bundles.
   - 100% passing Vitest suites and all 5 E2E test scripts.
