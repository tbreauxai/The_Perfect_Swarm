# Ultragoal Brief: Semantic Memory Vector Indexing (O(log n) Retrieval)

## Objective
Deploy high-performance semantic memory vector indexing to replace linear $O(N)$ memory scans with sub-linear $O(\log N)$ nearest-neighbor search and deduplication:
1. **Logarithmic Vector Index Engine**: Implement a zero-dependency, pure-TypeScript metric vector indexing engine (`VpTreeIndex` and `HnswVectorIndex`) supporting cosine and Euclidean distance metrics, $O(\log N)$ nearest-neighbor search, dynamic point insertion, and radius-threshold deduplication in `src/swarm/vectorIndex.ts`.
2. **MemoryCortex & Cache Integration**: Integrate vector indexing into `MemoryCortex` (`src/swarm/memory.ts`) for $O(\log N)$ deduplication on `store` and $O(\log N)$ candidate generation on `retrieve`, plus multi-tenant `appId` namespacing, persistence synchronization, and index telemetry.
3. **Verification & Distribution**: Export vector index primitives from `./src/swarm/index.ts`, rebuild client and swarm distribution bundles (`dist/` and `dist/swarm/`), and verify 100% pass rate across all Vitest suites and all 5 E2E test suites.

## Architecture Boundaries & Constraints
1. **Zero External Native Dependencies**: The vector indexing engine must be 100% pure TypeScript/JavaScript to preserve portability across Node.js, CLI, Vite browser runtime, and serverless environments.
2. **Strict User Model Preservation**: Never alter, override, or default model strings configured by the user in settings.
3. **Zero Model Blacklists**: Never add or check any model ban lists.
4. **Zero-Crash Worker Guarding**: All worker analyst outputs must flow through `guardAnalystResponse`.
5. **Exact Metric Triangle Inequality Pruning**: Vantage-Point Tree and HNSW implementations must strictly adhere to distance metric axioms to guarantee pruning soundness.
6. **Backward Compatibility**: Maintain 100% compatibility with existing `MemoryCortex` and `SemanticBaselineCache` APIs, snapshots, and tests.

## Micro-Goal Breakdown
1. `goal-1-vector-index-engine-hnsw-and-vptree`: Implement `VectorIndex` interface, `VpTreeIndex`, and `HnswVectorIndex` in `src/swarm/vectorIndex.ts` with comprehensive unit tests in `src/swarm/vectorIndex.test.ts`.
2. `goal-2-cortex-and-cache-vector-indexing-integration`: Integrate $O(\log N)$ vector indexing into `MemoryCortex` (`src/swarm/memory.ts`) and `SemanticBaselineCache` (`src/swarm/cache.ts`), verifying logarithmic retrieval speedup, radius deduplication, and multi-tenant isolation.
3. `goal-3-verification-and-bundle-build`: Update library exports in `src/swarm/index.ts` and `package.json`, rebuild client and swarm distribution bundles, and verify 100% passing across all Vitest and 5 E2E test suites.
