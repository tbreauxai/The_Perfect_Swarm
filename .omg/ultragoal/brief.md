# Ultragoal Brief: High-Throughput Swarm Optimization for Betting & Prediction Workloads

## Objective
Optimize swarm processing speed and eliminate the 180-second timeout in betting and prediction analysis without sacrificing accuracy or functionality. Achieve sub-30s initial responses (streaming early partial predictions) and sub-60s refined analyses through five primary optimization vectors:

1. **Parallel Worker Pool for Independent Tasks**:
   - Parallelize independent prediction tasks (team form analysis, H2H history, market odds evaluation, prop models) across concurrent execution lanes using worker pools.
   - Batch inputs and dynamically balance workloads across available compute.

2. **Streaming / Chunked Responses with Early Partial Results**:
   - Progressive streaming of intermediate findings via Server-Sent Events (`swarm_partial` / `swarm_stage`).
   - Deliver actionable initial predictions to the client in <30 seconds before complete manager synthesis and critic verification conclude.

3. **Tiered Model Inference & Early-Exit Logic**:
   - Tier 1: Fast approximation model/heuristic generating preliminary odds, spreads, and probabilities.
   - Confidence Gate: Early exit if Tier 1 confidence score exceeds threshold (e.g. >0.85), bypassing heavy multi-pass inference when consensus is definitive.
   - Tier 2: Accurate refinement pass triggered only when uncertainty or high volatility is detected, completing within <60 seconds total.

4. **Domain Sub-Computation Caching**:
   - High-performance TTL caching for frequent sub-computations: team form indices, head-to-head records, baseline team stats, and market odds snapshots.
   - Avoid redundant LLM prompt expansion and external calculations across swarm runs and analyst nodes.

5. **Token Weight Profiling & Pre-Filtering**:
   - Profile input metadata token weight and calculate divergence against historical baselines.
   - Pre-filter irrelevant data, stale markets, and noise before heavy LLM/ML passes.
   - Integrate prompt compression to drastically lower token processing latency.

## Architecture Boundaries
- Zero external runtime dependencies; pure TypeScript compatible with Node.js, Bun, and Edge runtimes (Cloudflare Workers/Pages).
- Strict adherence to `MEMORY.md`: NEVER ban/blacklist models, NEVER override user-configured models, maintain zero-crash worker guarding (`guardAnalystResponse`).
- Core optimization components isolated in `src/swarm/optimization.ts` and integrated cleanly into `src/swarm/engine.ts`, `src/swarm/server.ts`, and `src/swarm/index.ts`.
- 100% backward compatibility with all existing test suites, SSE streaming clients, and provider adapters.
