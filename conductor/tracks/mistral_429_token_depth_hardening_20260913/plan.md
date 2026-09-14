# Implementation Plan: Swarm Execution Hardening (Mistral 429 Transparency & Token Depth Allocation)

## Phase 1: Mistral 429 Transparency & Fast-Fail Optimization (TDD)

- [x] Task: Write Failing Tests for Mistral 429 Handling and Non-Blocking Mutex (TDD Red Phase) (c4e8391)
  - [x] Write unit test verifying structured Mistral 429 (Code 1300) transparent error reporting
  - [x] Write unit test verifying mutex release on error (no 31s freeze)
  - [x] Confirm tests fail as expected
- [~] Task: Implement Transparent Error Reporting & Non-Blocking Mutex in MistralAdapter (TDD Green Phase)
  - [ ] Release mutex immediately on 429 errors to eliminate 31s freeze
  - [ ] Return clean diagnostic message without silent provider substitution
  - [ ] Confirm all tests pass (Green Phase)
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 2: Token Budget Expansion & Deep Metadata Chunking (TDD)

- [ ] Task: Write Failing Tests for Token Budget Expansion and Deep Chunking (TDD Red Phase)
  - [ ] Write unit tests verifying expanded token budgets and chunk boundary continuity
- [ ] Task: Expand Token Allocations and Improve Metadata Chunking (TDD Green Phase)
  - [ ] Adjust default maxTokens allocations in adapters and profiler
  - [ ] Enhance chunking algorithm in `profiler.ts` to preserve metadata depth
  - [ ] Confirm all tests pass (Green Phase)
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 3: Full Regression Test & Build Verification

- [ ] Task: Full Regression Test & Build Verification
  - [ ] Run `npx tsc --noEmit` to verify type safety
  - [ ] Run `npm run build` to verify client and swarm distribution builds
  - [ ] Run `npm test` to verify all 5 core test suites pass 100%
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)
