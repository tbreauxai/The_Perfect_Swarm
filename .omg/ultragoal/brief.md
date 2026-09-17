# Ultragoal Brief: Swarm Optimization Roadmap

## Objective
Execute the three-priority roadmap to establish solid performance baselines, reduce token expenditure, and adaptively schedule specialist agents:
1. **First Priority**: Instrument key metrics (task completion rate, latency) to establish solid baselines.
2. **Second Priority**: Deploy lightweight semantic baseline caching to immediately lower token cost.
3. **Third Priority**: Introduce reinforcement learning for adaptive scheduling based on agent capability profiling.

## Architecture Boundaries & Constraints
1. **Zero Model Blacklists**: Never add or check any model ban lists. Any user model is strictly valid.
2. **Strict User Model Preservation**: Never alter, override, or default model strings configured by the user in settings.
3. **Zero-Crash Worker Guarding**: All specialist outputs must flow through `guardAnalystResponse` to safely handle prose/markdown/JSON without throwing fatal `SCHEMA_VALIDATION_FAILED` crashes.
4. **Non-Breaking Compatibility**: Maintain 100% backward compatibility across all 5 test suites (`test:portable`, `test:simulation`, `test:dist`, `test:cli`, `test:server`) and Vitest test suites.

## Micro-Goal Breakdown
1. `goal-1-instrument-key-metrics`: Instrument task completion rate, latency percentiles (p50, p95, EMA), and error tracking baselines in `src/swarm/profiler.ts` and `src/swarm/engine.ts`.
2. `goal-2-semantic-baseline-caching`: Deploy lightweight semantic baseline caching in `src/swarm/cache.ts` using similarity scoring to bypass redundant LLM calls on near-identical tasks.
3. `goal-3-reinforcement-learning-adaptive-scheduling`: Implement multi-armed bandit / reinforcement learning capability profiling in `src/swarm/loadBalancer.ts` for adaptive scheduling based on verification outcomes and past latency.
