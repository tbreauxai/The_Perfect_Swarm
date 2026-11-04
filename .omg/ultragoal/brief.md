# Ultragoal Brief: Token & Throughput Optimization Implementation Plan

## Objective
Implement comprehensive engineering optimizations across compression, JSON repair, scorecard triage, predictive flow control, provider multiplexing, hierarchical map-reduce, semantic caching, RL load balancing, and sliding-window memory rotation as specified in `todo.md`, verify with full test suites, and clear `todo.md`.

## Architecture Boundaries & Phases
1. **Phase 1: Immediate Token Reduction & Zero-Retry Guarantees**
   - `TokenAwarePromptCompressor` key minification, inverse key restoration, and `[xN]` repeated line deduplication.
   - Zero-retry deterministic JSON repair in `responseGuards.ts` and `_repaired: true` tracking.
   - Early-exit scorecard mode for anomaly detection in `scorecard.ts` and `scorecardManager.ts`.
2. **Phase 2: Predictive Flow Control & Provider Multiplexing**
   - 80% proactive token pacing and predictive backpressure in `AdaptiveLoadBalancer` and `AdaptiveTaskScheduler`.
   - Cross-provider parallel chunk multiplexing in `clusterPipeline.ts`.
   - Tiered model offloading in `fastPath.ts`.
3. **Phase 3: Hierarchical Aggregation & Adaptive Intelligence**
   - Hierarchical Map-Reduce micro-batch cluster digests (>6 chunks) in `clusterPipeline.ts`.
   - Semantic caching with RRF and threshold >= 0.88 in `semanticCacheInterceptor.ts` and `cortex.ts`.
   - RL routing reward $R = w_{\text{success}} - w_{\text{latency}} - w_{\text{cost}}$ in `AdaptiveLoadBalancer`.
   - New `src/swarm/conversation/slidingWindow.ts` for sliding window memory rotation (<6k tokens).
4. **Phase 4: Full Verification & Todo Clearance**
   - All tests, lint, simulation, and build pass cleanly; clear `todo.md`.
