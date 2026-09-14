# Implementation Plan: Bug - Qdrant Cortex Hang

## Phase 1: Diagnosing & Fixing the Embedding Timeout Hang (Red/Green Phase)
- [x] Task: Reduce `GeminiEmbeddingProvider` timeout from 30,000ms to a sensible 5,000ms (5 seconds) to prevent UI stalls.

## Phase 2: Resolving UI Silent Stream Stops
- [x] Task: Remove `isValidModel` rejection list to allow `gemini-3.5-flash` per user feedback.
- [x] Task: Audit `engine.ts` agent creation to prevent empty/missing models from triggering 10-minute retry blocks.

## Phase 3: Verification & Checkpoint (Refer to workflow.md)
- [x] Task: Phase Verification & Checkpoint (Refer to workflow.md)
