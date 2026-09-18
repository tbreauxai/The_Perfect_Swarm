# Ultragoal Brief: Baseline Profiling & Metrics Collection

## Objective
Implement comprehensive, unified baseline profiling and metrics collection across all `@perfect-swarm/core` subsystems (Tiered Caching, Adaptive Scheduler, Prompt Compression, Vector Indexing, Hierarchical Routing, Speculative Execution, and SwarmEngine). Provide automated performance benchmarking, latency percentile baselines (p50, p90, p95, p99, EMA), token economy accounting, and anomaly/drift detection with zero external runtime dependencies.

## Architecture Boundaries
- **Module**: `src/swarm/profiler.ts`
- **Zero Runtime Dependencies**: Pure TypeScript conforming to Node.js built-ins.
- **Core Components**:
  - `UnifiedSwarmProfiler`: Aggregates cross-subsystem telemetry into unified baseline performance reports.
  - `SubsystemBaselines`:
    - Cache Baselines (L1/L2/L3 hit rates, quantization compression ratios, memory saved).
    - Scheduler Baselines (queue wait times, work-stealing frequencies, rate-limit backpressure delays).
    - Compression Baselines (token reduction ratios, tokens saved, dedup rates).
    - Vector Indexing Baselines (sub-linear search comparisons, triangle inequality pruning efficiency).
    - Hierarchy Baselines (tree depth, delegation rate, escalation rate).
    - Speculative Baselines (parallel speedup factors, conflict arbitration rates).
  - `PerformanceAnomalyDetector`: Evaluates real-time execution against baseline distributions (p95/p99 + 2σ) to flag performance regressions.
  - `SwarmBenchmarkHarness`: Built-in synthetic workload runner measuring ops/sec and throughput for local and CI benchmarking (`npm run bench`).
  - `CLI Integration`: Expose `perfect-swarm profile` and `perfect-swarm bench` in `bin/cli.js`.

## Verification Criteria
- Unit tests in `src/swarm/profiler.test.ts` verifying subsystem aggregation, percentile calculation, and anomaly detection.
- Integration tests in `src/swarm/profiler-engine.test.ts` verifying engine-level telemetry integration and workflow baseline reporting.
- Dual ESM/CJS build verification and live execution of `npm run bench` capturing real baseline numbers.
- 100% passing test battery across all Vitest suites and 5 E2E test suites.
