# Implementation Plan: Large Data Scale Audit & Swarm Resilience Hardening

## Overview
A structured, test-driven implementation plan to audit and harden the Swarm engine for processing large structured datasets (5-10MB / 50k-100k+ rows) without runtime errors, provider context overflows, or silent data truncation.

---

## Phase 1: High-Volume Payload Profiling & Zero-Loss Chunking [checkpoint: 0437282]
Focus: Eliminate silent chunk dropping, support large data profiles, and preserve tabular structure (CSV headers, JSON delimiters).

- [x] Task: Write Failing Unit & Stress Tests for Data Profiling [edb50e9]
  - [x] Write unit tests in `src/swarm/profiler.test.ts` for payloads exceeding 8 chunks (verifying all chunks are retained without middle-loss).
  - [x] Add test cases validating CSV header propagation across all generated chunks.
  - [x] Add test cases verifying handling of 5MB+ raw string inputs without crashing `profileData`.
  - [x] Confirm tests fail (Red Phase).

- [x] Task: Implement Zero-Loss Chunking & Structure-Aware Segmentation [0437282]
  - [x] Refactor `profileData` in [src/swarm/profiler/dataProfiler.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/profiler/dataProfiler.ts) to raise safe memory limits and avoid premature truncation.
  - [x] Refactor `createTokenChunks` in [src/swarm/profiler/dataProfiler.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/profiler/dataProfiler.ts) to remove the hard `maxChunks` truncation, adopting hierarchical chunk lists with CSV header repetition.
  - [x] Run tests and verify all pass (Green Phase).

- [x] Task: Phase Verification & Checkpoint (Refer to workflow.md) [0437282]

---

## Phase 2: Hierarchical Map-Reduce Batching & Specialist Wave Scheduling [checkpoint: bf4721b]
Focus: Scale execution across large chunk counts without saturating system resources or dropping unassigned chunks.

- [x] Task: Write Failing Tests for Multi-Wave Chunk Execution [1573772]
  - [x] Create tests in `src/swarm/engine/clusterPipeline.largeData.test.ts` simulating 10+ chunks across analyst specialists.
  - [x] Test wave scheduling ensuring no active analyst is starved and chunks are processed in bounded concurrency waves.
  - [x] Confirm tests fail (Red Phase).

- [x] Task: Implement Hierarchical Map-Reduce Batching [bf4721b]
  - [x] Update [src/swarm/engine/clusterPipeline.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/engine/clusterPipeline.ts) to batch chunk evaluations into sequential/pipelined waves when chunk count exceeds specialist capacity.
  - [x] Integrate intermediate cluster digests to roll up findings per wave into structured intermediate summaries.
  - [x] Run tests and verify all pass (Green Phase).

- [x] Task: Phase Verification & Checkpoint (Refer to workflow.md) [bf4721b]

---

## Phase 3: Adaptive Manager Synthesis & Context Ceiling Protection
Focus: Prevent manager prompt blowups (`context_length_exceeded`) when consolidating massive analyst reports.

- [x] Task: Write Failing Tests for Manager Synthesis Protection [fc036c1]
  - [x] Create unit tests in `src/swarm/engine/synthesisPipeline.test.ts` validating prompt budget constraints against various model limits (8k Groq, 32k Mistral, 128k Gemini).
  - [x] Simulate 20+ voluminous analyst reports and assert the compiled manager prompt never exceeds target token limits.
  - [x] Confirm tests fail (Red Phase).

- [x] Task: Implement Recursive Synthesis Reduction & Token Fitting [04e71dd]
  - [x] Update [src/swarm/engine/synthesisPipeline.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/engine/synthesisPipeline.ts) to automatically trigger hierarchical rollup/compression when uncompressed reports exceed 60% of the manager's context limit.
  - [x] Implement fail-safe token trimming in `executeManagerSynthesis` to ensure prompts are strictly within provider bounds before dispatch.
  - [x] Run tests and verify all pass (Green Phase).

- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

---

## Phase 4: Provider TPM Rate Pacing & Express Ingestion Hardening
Focus: Prevent 429 rate limit errors under sustained load and ensure HTTP server accepts large payloads.

- [ ] Task: Write Failing Tests for Rate Pacing and Express Body Parsing
  - [ ] Add tests in `src/swarm/providers/groq.resilience.test.ts` testing sustained multi-chunk calls under simulated tight TPM quotas.
  - [ ] Add tests in `src/swarm/server/app.test.ts` verifying 10MB payload ingestion and error handling.
  - [ ] Confirm tests fail (Red Phase).

- [ ] Task: Implement Dynamic Dispatch Pacing & Server Payload Sizing
  - [ ] Update [src/swarm/engine/analystExecution.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/engine/analystExecution.ts) with adaptive inter-call delays tailored to the provider's known RPM/TPM ceilings.
  - [ ] Verify and configure body parser limits (10MB) in [src/swarm/server/app.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/server/app.ts) to handle high-volume JSON/CSV requests.
  - [ ] Run tests and verify all pass (Green Phase).

- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

---

## Phase 5: End-to-End Stress Verification & Regression Suite
Focus: Full system verification under production-scale loads.

- [ ] Task: Implement Comprehensive Large-Data Stress Suite
  - [ ] Create `test-large-data-simulation.ts` executing end-to-end swarm analysis on a 50k-row CSV payload.
  - [ ] Assert zero silent chunk truncation, successful manager synthesis, and clean process exit.

- [ ] Task: Run Full Repository Verification Suite
  - [ ] Run `npm run lint` (`tsc --noEmit`).
  - [ ] Run `npm run test:unit`.
  - [ ] Run `npm run test:portable`.
  - [ ] Run `npm run test:dist`.
  - [ ] Run `npm run build:swarm`.

- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)
