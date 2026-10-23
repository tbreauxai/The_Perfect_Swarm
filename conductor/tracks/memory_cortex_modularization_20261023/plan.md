# Implementation Plan: Memory Cortex & Storage Backend Decomposition

## Overview
A structured, test-driven refactoring plan to decompose the 1,245-line `MemoryCortex` class into modular, single-responsibility units (Storage Backends, RRF Ranker, Persistence Manager, Consolidator) while preserving 100% backward compatibility on the root facade.

---

## Phase 1: Storage Backend Abstraction & In-Memory / Qdrant Adapters
Focus: Define `StorageBackend` contract and encapsulate raw storage operations.

- [ ] Task: Define StorageBackend Interface & Write Unit Tests
  - [ ] Create `src/swarm/memory/storage/types.ts` defining `StorageBackend`, `StoragePoint`, and filter types.
  - [ ] Write unit tests in `src/swarm/memory/storage/inMemoryStorage.test.ts` testing insert, search, filter, and delete operations.
  - [ ] Confirm tests fail (Red Phase).

- [ ] Task: Implement InMemoryStorageAdapter & QdrantStorageAdapter
  - [ ] Implement `InMemoryStorageAdapter` in `src/swarm/memory/storage/inMemoryStorage.ts`.
  - [ ] Implement `QdrantStorageAdapter` in `src/swarm/memory/storage/qdrantStorage.ts` encapsulating REST operations, health checks, and fallback triggers.
  - [ ] Run tests and verify all pass (Green Phase).

- [ ] Task: Phase Verification & Checkpoint

---

## Phase 2: Reciprocal Rank Fusion (RRF) Ranking Module
Focus: Extract hybrid retrieval scoring and candidate fusion into an isolated ranking engine.

- [ ] Task: Write Failing Unit Tests for RRF Ranker
  - [ ] Create `src/swarm/memory/ranking/rrfRanker.test.ts` testing dense + lexical fusion, score normalization, tie-breaking, and top-K selection.
  - [ ] Confirm tests fail (Red Phase).

- [ ] Task: Implement RrfRanker
  - [ ] Implement `RrfRanker` in `src/swarm/memory/ranking/rrfRanker.ts`.
  - [ ] Run tests and verify all pass (Green Phase).

- [ ] Task: Phase Verification & Checkpoint

---

## Phase 3: Persistence & Serialization Manager
Focus: Extract disk snapshotting, JSON/JSONL serialization, and import/export mechanics.

- [ ] Task: Write Failing Unit Tests for CortexPersistenceManager
  - [ ] Create `src/swarm/memory/persistence/cortexPersistence.test.ts` testing atomic JSON writes, JSONL streaming, and schema validation.
  - [ ] Confirm tests fail (Red Phase).

- [ ] Task: Implement CortexPersistenceManager
  - [ ] Implement `CortexPersistenceManager` in `src/swarm/memory/persistence/cortexPersistence.ts`.
  - [ ] Run tests and verify all pass (Green Phase).

- [ ] Task: Phase Verification & Checkpoint

---

## Phase 4: Memory Consolidation & Few-Shot Distillation
Focus: Extract low-quality pruning, clustering, and few-shot exemplar generation.

- [ ] Task: Write Failing Unit Tests for CortexConsolidator
  - [ ] Create `src/swarm/memory/consolidation/cortexConsolidator.test.ts` testing threshold pruning, exemplar formatting, and deduplication.
  - [ ] Confirm tests fail (Red Phase).

- [ ] Task: Implement CortexConsolidator
  - [ ] Implement `CortexConsolidator` in `src/swarm/memory/consolidation/cortexConsolidator.ts`.
  - [ ] Run tests and verify all pass (Green Phase).

- [ ] Task: Phase Verification & Checkpoint

---

## Phase 5: MemoryCortex Facade Integration & Full System Verification
Focus: Wire extracted modules into `MemoryCortex` and verify zero regressions across the codebase.

- [ ] Task: Refactor MemoryCortex to Delegate to Submodules
  - [ ] Refactor `src/swarm/memory/cortex.ts` to instantiate and delegate to `InMemoryStorageAdapter`, `QdrantStorageAdapter`, `RrfRanker`, `CortexPersistenceManager`, and `CortexConsolidator`.
  - [ ] Verify `cortex.ts` line count is reduced to under 400 lines while retaining 100% public API compatibility.

- [ ] Task: Run Full Repository Verification Suite
  - [ ] Run `npm run lint` (`tsc --noEmit`).
  - [ ] Run `npm run test:unit`.
  - [ ] Run `npm run test:portable`.
  - [ ] Run `npm run test:dist`.
  - [ ] Run `npm run build:swarm`.

- [ ] Task: Phase Verification & Checkpoint
