# Implementation Plan: Resolve Swarm Hang in Analyzing State & Codebase Audit Hardening

## Phase 1: Failover & Timeout Hardening (Engine, Adapters, Cortex)
- [x] Task: Write failing unit tests for immediate 429 failover, Gemini timeout guards, and stream error handling (Red) (9c6edce)
- [ ] Task: Implement immediate failover in `Agent.run` when fallbacks exist and fix `test-multi-app-simulation.ts` (Green)
- [ ] Task: Add timeout protection to `GeminiAdapter` and `GeminiEmbeddingProvider` with graceful fallback (Green)
- [ ] Task: Update `SwarmClient.streamRemote` to handle `swarm_error` events properly (Green)
- [ ] Task: Guard `profiler.ts` against unbounded single-line payloads (Green)
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 2: Server-Side Streaming & Heartbeat Resilience
- [ ] Task: Write integration tests for SSE keep-alive heartbeat and connection abort cleanup (Red)
- [ ] Task: Implement periodic keep-alive comments and abort signal handling in `src/swarm/server.ts` (Green)
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 3: Client UI Real-Time Streaming & Cancel Control
- [ ] Task: Implement real-time SSE stream consumption in `src/App.tsx` via `/api/swarm/stream` with live timeline rendering
- [ ] Task: Add "Cancel Analysis" button with `AbortController` in `src/App.tsx` and error recovery
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 4: Full Regression & Multi-App Audit Verification
- [ ] Task: Run full test suite (`npm test`, vitest, simulation, portable swarm, CLI) and verify zero hangs
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)
