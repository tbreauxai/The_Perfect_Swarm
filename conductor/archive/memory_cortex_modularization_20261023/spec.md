# Specification: Memory Cortex & Storage Backend Decomposition

## Overview
Decompose the 1,245-line God Object [`src/swarm/memory/cortex.ts`](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/memory/cortex.ts) into focused, single-responsibility modules: storage backends (Qdrant REST vs. in-memory vector store), reciprocal rank fusion (RRF) ranking, snapshot disk persistence, and memory consolidation, while preserving 100% backward compatibility on the `MemoryCortex` facade.

---

## Key Problem Vectors Identified in Code Audit
1. **Multi-Responsibility Overload**: `cortex.ts` currently manages:
   - Qdrant REST client initialization, collection schema creation, payload indexing, and fallback handling.
   - In-memory vector store fallback, local cosine similarity loops, and BM25 sparse vector integration.
   - Reciprocal Rank Fusion (RRF) score normalization, dense/lexical weighting, and candidate deduplication.
   - Disk persistence auto-loading and atomic snapshot write-to-file serialization.
   - Memory pruning (cleaning low-reward entries), consolidation, and few-shot exemplar formatting.
   - Diagnostic metrics aggregation (latency EMA, Qdrant availability, collection size).
2. **Coupled Storage Implementations**: Modifying in-memory behavior risks inadvertently breaking Qdrant fallback paths, and vice versa.
3. **High Maintenance Cost**: 1,245 lines with tight coupling makes testing individual components in isolation difficult.

---

## Functional Requirements

### 1. Storage Backend Abstraction
- Define `StorageBackend` interface in `src/swarm/memory/storage/types.ts`.
- Implement `InMemoryStorageAdapter` in `src/swarm/memory/storage/inMemoryStorage.ts` encapsulating in-memory vector search, points Map, and payload filtering.
- Implement `QdrantStorageAdapter` in `src/swarm/memory/storage/qdrantStorage.ts` encapsulating Qdrant REST calls, collection lifecycle, and payload indexing.

### 2. Reciprocal Rank Fusion (RRF) Ranking Module
- Extract hybrid retrieval ranking into `src/swarm/memory/ranking/rrfRanker.ts`.
- Encapsulate RRF ranking logic: combining dense similarity and lexical BM25 scores with configurable weights and rank constants ($k = 60$).

### 3. Snapshot & Disk Persistence Manager
- Extract disk auto-persistence, JSON/JSONL serialization, and import/export mechanics into `src/swarm/memory/persistence/cortexPersistence.ts`.

### 4. Memory Consolidation & Distillation
- Extract low-quality pruning, memory merging, and few-shot exemplar formatting into `src/swarm/memory/consolidation/cortexConsolidator.ts`.

### 5. Backward-Compatible MemoryCortex Facade
- Refactor `src/swarm/memory/cortex.ts` to act as a lightweight facade orchestrating the extracted modules.
- Maintain 100% backward compatibility for all public methods: `store()`, `retrieve()`, `exportSnapshot()`, `importSnapshot()`, `rateMemory()`, `consolidateMemories()`, `getFewShotExemplars()`, `wipeCollection()`, `collectDiagnostics()`, `getStore()`, etc.

---

## Non-Functional Requirements
- **100% Backward Compatibility**: Public APIs, types, and module exports must remain identical.
- **Zero Latency Regression**: Sub-millisecond in-memory vector search; no added overhead to Qdrant REST queries.
- **Google TypeScript Style Guide**: Explicit typing, no `var`, no `any`, named exports.
- **Test Integrity**: Full pass across all 104 existing test suites.

---

## Acceptance Criteria
1. `src/swarm/memory/cortex.ts` reduced from 1,245 lines to under 400 lines.
2. Extracted submodules (`storage/`, `ranking/`, `persistence/`, `consolidation/`) covered by focused unit tests.
3. Full test suites pass: `npm run lint` (0 errors), `npm run test:unit`, `npm run test:portable`, `npm run test:dist`, `npm run build:swarm`.
