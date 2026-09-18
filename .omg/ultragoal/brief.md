# Ultragoal Brief: Continuous Learning Loops with Automated A/B Testing

## Objective
Deploy continuous learning loops with automated A/B testing of agent configurations against production metrics (RLAIF quality scores, wall-clock latency, token efficiency, and error rates) with statistical significance evaluation, automated promotion of superior configurations, and fail-safe circuit breaker rollbacks.

## Background & Problem Statement
Currently, swarm agent configurations (roles, prompts, temperature, model provider assignments, and specialist parameters) are static or manually calibrated. While `SpecialistCapabilityProfiler` tracks specialist performance via UCB1, there is no end-to-end experiment engine that can test alternative configuration variants (e.g. Prompt V1 vs V2, differing specialist temperature/models, or topology strategies) against real production workloads, measure multi-dimensional performance metrics, and automatically promote winning configurations or roll back regressions.

## Architecture Boundaries
1. **A/B Testing & Statistical Evaluation Engine (`src/swarm/experiment.ts`)**:
   - `AgentExperimentManager`: Experiment lifecycle (draft, active, concluded, rolled_back), variant definition (control/baseline vs treatment/candidate), deterministic hashing or bandit allocation.
   - `StatisticalAnalyzer`: Metric comparison (mean, variance, Welch's t-test / p-value calculation, confidence intervals, effect size).
   - Multi-metric scoring: Composite utility function balancing RLAIF quality score (critic rating), wall-clock latency, and token consumption.
   - Automated Promotion & Circuit Breaker: Auto-promote treatment to active configuration when min sample size is reached and p < 0.05 with positive delta; instantly abort and roll back if error rate spikes or quality drops below safety threshold.
2. **Swarm Engine & Learning Loop Integration (`src/swarm/engine.ts`)**:
   - Support `settings.experimentSettings` in `SwarmEngineSettings`.
   - Resolve active variant configuration before workflow execution.
   - Attach variant metadata to context and telemetry events (`Agent A/B Variant Dispatched`, `Agent Experiment Evaluated`, `Agent Configuration Promoted`).
   - Feed post-synthesis production metrics (critic verification score, duration, tokens, anomalies) directly back into the experiment manager and continuous learning loop.
3. **Distribution & Backward Compatibility**:
   - Zero external runtime dependencies (pure TypeScript statistical analysis).
   - Export from `@perfect-swarm/core` and subpath `@perfect-swarm/core/experiment`.
   - Dual ESM/CJS distribution bundles.
   - 100% passing Vitest suites and all 5 E2E test suites.
