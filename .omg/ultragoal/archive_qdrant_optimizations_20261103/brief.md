# Ultragoal Brief: Qdrant Memory & Cortex Optimization Plan

## Objective
Implement architectural modernization, latency optimizations, server-side prefiltering, count aggregation, storage adapter tuning/pagination, and write micro-batching across Qdrant Memory and Learning Persistence systems as specified in `todo.md`, then clear `todo.md`.

## Target Architecture & Boundaries
1. Diagnostics & Server-Side Filtering (`src/swarm/memory/diagnostics.ts`, `src/swarm/memory/cortex.ts`, `src/swarm/memory/types.ts`)
   - DuelOdds safeguard: Query filtering for `appId` must use `should` disjunction with `originApp`.
   - Use `client.count()` for point metrics (total, graded, wins, losses, pushes) with fallback if `.count()` unavailable.
2. Storage Adapter (`src/swarm/memory/storage/qdrantStorage.ts`, `src/swarm/memory/storage/types.ts`)
   - Schema check before index creation to skip redundant index calls while ensuring newly required fields are indexed.
   - Offset pagination loop in `scroll()` with safety cap.
   - Deduplication option in `storeBatch` (default: false).
   - Configurable RRF (k: 60 default) and HNSW/quantization profiles.
3. Persistence Batching & Watermarking (`src/swarm/learning-persistence.ts`, `analystLedger.ts`, `snapshotPipeline.ts`)
   - In-memory write buffer with debounce timer (`unref()` called) and explicit `flush(): Promise<void>`.
   - `sinceTimestamp` watermark loading in `loadAll()`.
   - Parallelization of orthogonal remote collection queries via `Promise.all`.
4. Verification & Clear:
   - Full gate validation: `npm run lint`, unit tests, server tests, `npm run build`.
   - Clear `todo.md`.
