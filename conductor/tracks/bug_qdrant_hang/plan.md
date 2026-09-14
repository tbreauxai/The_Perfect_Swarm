# Implementation Plan: Bug - Qdrant Cortex Hang

## Phase 1: Diagnosing & Fixing the Embedding Timeout Hang (Red/Green Phase)
- [ ] Task: Reduce `GeminiEmbeddingProvider` timeout from 30,000ms to a sensible 3,000ms (3 seconds) to prevent UI stalls.
- [ ] Task: Wrap `this.embeddingProvider.embed()` in `memory.ts` with `withTimeout` to act as a secondary fallback if the provider itself hangs.

## Phase 2: Resolving UI Silent Stream Stops
- [ ] Task: Audit `engine.ts` analysts loop for unhandled promise rejections that might break `Promise.all` without reporting to the UI stream.
- [ ] Task: Verify the `swarm_error` correctly reports embedding timeouts to the UI.

## Phase 3: Verification & Checkpoint (Refer to workflow.md)
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)
