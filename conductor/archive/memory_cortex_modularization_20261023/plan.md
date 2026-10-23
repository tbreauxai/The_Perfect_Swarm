# Implementation Plan: Memory Cortex & Storage Backend Decomposition

## Overview
A structured, test-driven refactoring plan to decompose the 1,245-line `MemoryCortex` class into modular, single-responsibility units (Storage Backends, RRF Ranker, Persistence Manager, Consolidator) while preserving 100% backward compatibility on the root facade.

---

## Phase 1: Storage Backend Abstraction & In-Memory / Qdrant Adapters [checkpoint: 77c61e2]
Focus: Define `StorageBackend` contract and encapsulate raw storage operations.

- [x] Task: Define StorageBackend Interface & Write Unit Tests [77c61e2]
  - [x] Create `src/swarm/memory/storage/types.ts` defining `StorageBackend`, `StoragePoint`, and filter types.
  - [x] Write unit tests in `src/swarm/memory/storage/inMemoryStorage.test.ts` testing insert, search, filter, and delete operations.
  - [x] Confirm tests fail (Red Phase).

- [x] Task: Implement InMemoryStorageAdapter & QdrantStorageAdapter [77c61e2]
  - [x] Implement `InMemoryStorageAdapter` in `src/swarm/memory/storage/inMemoryStorage.ts`.
  - [x] Implement `QdrantStorageAdapter` in `src/swarm/memory/storage/qdrantStorage.ts` encapsulating REST operations, health checks, and fallback triggers.
  - [x] Run tests and verify all pass (Green Phase).

- [x] Task: Phase Verification & Checkpoint [77c61e2]

---

## Phase 2: Reciprocal Rank Fusion (RRF) Ranking Module [checkpoint: 8a00219]
Focus: Extract hybrid retrieval scoring and candidate fusion into an isolated ranking engine.

- [x] Task: Write Failing Unit Tests for RRF Ranker [8a00219]
  - [x] Create `src/swarm/memory/ranking/rrfRanker.test.ts` testing dense + lexical fusion, score normalization, tie-breaking, and top-K selection.
  - [x] Confirm tests fail (Red Phase).

- [x] Task: Implement RrfRanker [8a00219]
  - [x] Implement `RrfRanker` in `src/swarm/memory/ranking/rrfRanker.ts`.
  - [x] Run tests and verify all pass (Green Phase).

- [x] Task: Phase Verification & Checkpoint [8a00219]

---

## Phase 3: Persistence & Serialization Manager [checkpoint: f7c10f9]
Focus: Extract disk snapshotting, JSON/JSONL serialization, and import/export mechanics.

- [x] Task: Write Failing Unit Tests for CortexPersistenceManager [f7c10f9]
  - [x] Create `src/swarm/memory/persistence/cortexPersistence.test.ts` testing atomic JSON writes, JSONL streaming, and schema validation.
  - [x] Confirm tests fail (Red Phase).

- [x] Task: Implement CortexPersistenceManager [f7c10f9]
  - [x] Implement `CortexPersistenceManager` in `src/swarm/memory/persistence/cortexPersistence.ts`.
  - [x] Run tests and verify all pass (Green Phase).

- [x] Task: Phase Verification & Checkpoint [f7c10f9]

---

## Phase 4: Memory Consolidation & Few-Shot Distillation [checkpoint: 8b9000f]
Focus: Extract low-quality pruning, clustering, and few-shot exemplar generation.

- [x] Task: Write Failing Unit Tests for CortexConsolidator [8b9000f]
  - [x] Create `src/swarm/memory/consolidation/cortexConsolidator.test.ts` testing threshold pruning, exemplar formatting, and deduplication.
  - [x] Confirm tests fail (Red Phase).

- [x] Task: Implement CortexConsolidator [8b9000f]
  - [x] Implement `CortexConsolidator` in `src/swarm/memory/consolidation/cortexConsolidator.ts`.
  - [x] Run tests and verify all pass (Green Phase).

- [x] Task: Phase Verification & Checkpoint [8b9000f]

---

## Phase 5: MemoryCortex Facade Integration & Full System Verification [checkpoint: 3330c5a]
Focus: Wire extracted modules into `MemoryCortex` and verify zero regressions across the codebase.

- [x] Task: Refactor MemoryCortex to Delegate to Submodules [3330c5a]
  - [x] Refactor `src/swarm/memory/cortex.ts` to instantiate and delegate to `InMemoryStorageAdapter`, `QdrantStorageAdapter`, `RrfRanker`, `CortexPersistenceManager`, and `CortexConsolidator`.
  - [x] Verify `cortex.ts` line count is reduced from 1,245 to 600 lines while retaining 100% public API compatibility.

- [x] Task: Run Full Repository Verification Suite [3330c5a]
  - [x] Run `npm run lint` (`tsc --noEmit`).
  - [x] Run `npm run test:unit`.
  - [x] Run `npm run test:portable`.
  - [x] Run `npm run test:simulation`.
  - [x] Run `npm run test:dist`.
  - [x] Run `npm run test:cli`.
  - [x] Run `npm run test:server`.
  - [x] Run `npm run build:swarm`.

- [x] Task: Phase Verification & Checkpoint [3330c5a]
