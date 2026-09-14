# Implementation Plan: Resolve Swarm Hang in Analyzing State & Codebase Audit Hardening

## Phase 1: Failover & Timeout Hardening (Engine, Adapters, Cortex)
- [x] Task: Write failing unit tests for immediate 429 failover, Gemini timeout guards, and stream error handling (Red) (9c6edce)
- [x] Task: Implement immediate failover in `Agent.run` when fallbacks exist and fix `test-multi-app-simulation.ts` (Green) (66e3b32)
- [x] Task: Add timeout protection to `GeminiAdapter` and `GeminiEmbeddingProvider` with graceful fallback (Green) (40945fc)
- [x] Task: Update `SwarmClient.streamRemote` to handle `swarm_error` events properly (Green) (3d79981)
- [x] Task: Guard `profiler.ts` against unbounded single-line payloads (Green) (b5897d4)
- [x] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 2: Server-Side Streaming & Heartbeat Resilience
- [x] Task: Write integration tests for SSE keep-alive heartbeat and connection abort cleanup (Red) (5d4890e)
- [x] Task: Implement periodic keep-alive comments and abort signal handling in `src/swarm/server.ts` (Green) (2e17d62)
- [x] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 3: Client UI Real-Time Streaming & Cancel Control
- [x] Task: Implement real-time SSE stream consumption in `src/App.tsx` via `/api/swarm/stream` with live timeline rendering (49e8106)
- [x] Task: Add "Cancel Analysis" button with `AbortController` in `src/App.tsx` and error recovery (49e8106)
- [x] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 4: Full Regression & Multi-App Audit Verification
- [x] Task: Run full test suite (`npm test`, vitest, simulation, portable swarm, CLI) and verify zero hangs (df0ea9c)
- [x] Task: Phase Verification & Checkpoint (Refer to workflow.md)
