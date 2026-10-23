# Ultragoal Brief: Code Audit Modularization & Deduplication

## Core Objective
Implement the modularization changes and code deduplications identified in the comprehensive Code Audit Report ([code_audit_report.md](file:///C:/Users/psych/.gemini/antigravity-ide/brain/8544bb9d-6f65-443d-bd6b-6591f662ddf3/code_audit_report.md)). Transform monolithic modules into high-cohesion, single-responsibility units, and extract shared utilities across math, hashing, token estimation, vector indexing, caching, provider adapters, SSE streaming, server routes, and frontend diagnostic components with 100% backward compatibility and zero test regressions.

## Scope & Key Phases
1. **Phase 1: Foundational Zero-Risk Utility Deduplication (`goal-1-math-hash-token-dedup`)**:
   - Extract `djb2Hash` in [src/swarm/utils/hash.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/utils/hash.ts) (unifying [tokenizer.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/memory/tokenizer.ts), [embeddings.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/memory/embeddings.ts), [agentExperiment.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/experiment/agentExperiment.ts), [semanticSimilarityEngine.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/cache/semanticSimilarityEngine.ts)).
   - Extract probability math (`clampProbability`, `logit`, `sigmoid`) in [src/swarm/math/probabilityMath.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/math/probabilityMath.ts) (unifying [probabilityCalibration.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/feedback/probabilityCalibration.ts) and [predictionEnsemble.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/engine/predictionEnsemble.ts)).
   - Consolidate vector cosine similarity on [src/swarm/vectorIndex/metricMath.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/vectorIndex/metricMath.ts) and [src/swarm/memory/vectorMath.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/memory/vectorMath.ts), removing duplicate loops in [conceptDriftDetector.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/feedback/conceptDriftDetector.ts) and [cortex.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/memory/cortex.ts).
   - Consolidate token counting onto [TokenEstimator](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/compression/tokenEstimator.ts) with `estimateFromChars` and `estimateFromText`.
   - Extract HTTP `retry-after` parser to [src/swarm/utils/httpTimeouts.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/utils/httpTimeouts.ts) (unifying [adaptiveLoadBalancer.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/loadBalancer/adaptiveLoadBalancer.ts) and [optimizationCaches.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/components/optimization/optimizationCaches.ts)).

2. **Phase 2: Vector Index & Semantic Cache Deduplication (`goal-2-vector-cache-index-dedup`)**:
   - Extract `BaseVectorIndex<T>` in [src/swarm/vectorIndex/baseIndex.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/vectorIndex/baseIndex.ts) for [hnswIndex.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/vectorIndex/hnswIndex.ts) and [vpTreeIndex.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/vectorIndex/vpTreeIndex.ts).
   - Extract generic `SemanticVectorCache<T>` in [src/swarm/cache/semanticVectorCache.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/cache/semanticVectorCache.ts) deduplicating shared LRU, TTL, and vector search in [actionPlanCache.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/actionPlanCache.ts) and [semanticCacheInterceptor.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/semanticCacheInterceptor.ts).

3. **Phase 3: Provider Adapters, SSE Streaming & Engine Tool Execution (`goal-3-provider-streaming-tool-dedup`)**:
   - Shared OpenAI-compatible REST call executor / base adapter in [src/swarm/providers/baseOpenAi.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/providers/baseOpenAi.ts) deduplicating 400 rejection retry, timeout handling, and 429 parsing across [groq.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/providers/groq.ts), [mistral.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/providers/mistral.ts), [openrouter.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/providers/openrouter.ts), [nvidia.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/providers/nvidia.ts), and [cloudflare.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/providers/cloudflare.ts).
   - Shared SSE stream parser in [src/swarm/utils/sseParser.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/utils/sseParser.ts) unifying [client.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/client.ts) and [useSwarmExecution.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/hooks/useSwarmExecution.ts).
   - Shared tool execution & context event recorder helper [src/swarm/engine/toolExecutionHelper.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/engine/toolExecutionHelper.ts) unifying [analystExecution.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/engine/analystExecution.ts), [fastPath.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/engine/fastPath.ts), and [clusterPipeline.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/engine/clusterPipeline.ts).

4. **Phase 4: Server Routes & CLI Decomposition (`goal-4-server-routes-and-cli-modularization`)**:
   - Decompose monolithic [src/swarm/server/app.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/server/app.ts) into modular Hono route handlers under `src/swarm/server/routes/` (`analyze.ts`, `feedback.ts`, `morning.ts`, `models.ts`).
   - Modularize monolithic [bin/cli.js](file:///C:/Dev/Workspaces/The_Perfect_Swarm/bin/cli.js) into `bin/commands/` (`doctor.js`, `init.js`, `run.js`, `bench.js`, etc.) with a clean command dispatcher.

5. **Phase 5: Monolithic UI Components Modularization (`goal-5-ui-components-modularization`)**:
   - Deduplicate [OptimizationCombinationsTable.tsx](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/components/optimization/OptimizationCombinationsTable.tsx) and [OptimizationHistoryTable.tsx](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/components/optimization/OptimizationHistoryTable.tsx) into shared `<OptimizationResultsTable />`.
   - Decompose [CortexDiagnosticsViewer.tsx](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/components/CortexDiagnosticsViewer.tsx) into focused subcomponents (`CortexOverviewCard`, `SeatAccuracyTable`, `CalibrationPanel`).
   - Extract timeline item and virtual list helpers from [SwarmEventTimeline.tsx](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/components/SwarmEventTimeline.tsx).

6. **Phase 6: End-to-End System Verification & Regression Suite (`goal-6-system-verification-and-benchmarking`)**:
   - Run `npm run lint` (`tsc --noEmit`), `npm run test:unit`, `npm run test:portable`, `npm run test:dist`, and `npm run build:swarm`.

## Constraints & Architectural Invariants
- 100% Backward Compatibility: Preserving all root facades, export paths in `package.json`, and function signatures.
- Zero Test Regressions: 98/98 test files (892/892 tests) must pass after every micro-goal.
- Preserved Model & Provider Policies: Strict adherence to existing provider chains, timeouts, and rate pacing.
