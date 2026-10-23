# Implementation Plan: Large Data Scale Audit & Swarm Resilience Hardening

## Overview
A structured, test-driven implementation plan to audit and harden the Swarm engine for processing large structured datasets (5-10MB / 50k-100k+ rows) without runtime errors, provider context overflows, or silent data truncation.

---

## Phase 1: High-Volume Payload Profiling & Zero-Loss Chunking
Focus: Eliminate silent chunk dropping, support large data profiles, and preserve tabular structure (CSV headers, JSON delimiters).

- [ ] Task: Write Failing Unit & Stress Tests for Data Profiling
  - [ ] Write unit tests in `src/swarm/profiler.test.ts` for payloads exceeding 8 chunks (verifying all chunks are retained without middle-loss).
  - [ ] Add test cases validating CSV header propagation across all generated chunks.
  - [ ] Add test cases verifying handling of 5MB+ raw string inputs without crashing `profileData`.
  - [ ] Confirm tests fail (Red Phase).

- [ ] Task: Implement Zero-Loss Chunking & Structure-Aware Segmentation
  - [ ] Refactor `profileData` in [src/swarm/profiler/dataProfiler.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/profiler/dataProfiler.ts) to raise safe memory limits and avoid premature truncation.
  - [ ] Refactor `createTokenChunks` in [src/swarm/profiler/dataProfiler.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/profiler/dataProfiler.ts) to remove the hard `maxChunks` truncation, adopting hierarchical chunk lists with CSV header repetition.
  - [ ] Run tests and verify all pass (Green Phase).

- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

---

## Phase 2: Hierarchical Map-Reduce Batching & Specialist Wave Scheduling
Focus: Scale execution across large chunk counts without saturating system resources or dropping unassigned chunks.

- [ ] Task: Write Failing Tests for Multi-Wave Chunk Execution
  - [ ] Create tests in `src/swarm/engine/clusterPipeline.largeData.test.ts` simulating 10+ chunks across analyst specialists.
  - [ ] Test wave scheduling ensuring no active analyst is starved and chunks are processed in bounded concurrency waves.
  - [ ] Confirm tests fail (Red Phase).

- [ ] Task: Implement Hierarchical Map-Reduce Batching
  - [ ] Update [src/swarm/engine/clusterPipeline.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/engine/clusterPipeline.ts) to batch chunk evaluations into sequential/pipelined waves when chunk count exceeds specialist capacity.
  - [ ] Integrate intermediate cluster digests to roll up findings per wave into structured intermediate summaries.
  - [ ] Run tests and verify all pass (Green Phase).

- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

---

## Phase 3: Adaptive Manager Synthesis & Context Ceiling Protection
Focus: Prevent manager prompt blowups (`context_length_exceeded`) when consolidating massive analyst reports.

- [ ] Task: Write Failing Tests for Manager Synthesis Protection
  - [ ] Create unit tests in `src/swarm/engine/synthesisPipeline.test.ts` validating prompt budget constraints against various model limits (8k Groq, 32k Mistral, 128k Gemini).
  - [ ] Simulate 20+ voluminous analyst reports and assert the compiled manager prompt never exceeds target token limits.
  - [ ] Confirm tests fail (Red Phase).

- [ ] Task: Implement Recursive Synthesis Reduction & Token Fitting
  - [ ] Update [src/swarm/engine/synthesisPipeline.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/engine/synthesisPipeline.ts) to automatically trigger hierarchical rollup/compression when uncompressed reports exceed 60% of the manager's context limit.
  - [ ] Implement fail-safe token trimming in `executeManagerSynthesis` to ensure prompts are strictly within provider bounds before dispatch.
  - [ ] Run tests and verify all pass (Green Phase).

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
