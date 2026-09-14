# Specification: Resolve Swarm Hang in Analyzing State & Codebase Audit Hardening

## Overview
Resolves the issue where "run swarm gets stuck analyzing forever", audits the codebase for asynchronous stalls, and hardens streaming, failover, and timeout mechanisms across UI, server, and engine:
1. **Real-Time UI SSE Streaming & Cancel Button**: Replaces blocking `fetch('/api/swarm/analyze')` in `App.tsx` with resilient Server-Sent Events (`/api/swarm/stream`) streaming, updating the `SwarmEventTimeline` live as events occur, providing an `AbortController` cancel button, and rendering dynamic loading progress.
2. **Server SSE Resilience & Keep-Alive Heartbeat**: Adds periodic heartbeat comments (`:keepalive\n\n`) to `/api/swarm/stream` in `src/swarm/server.ts` to prevent intermediate proxy, Vite, and browser timeouts during long multi-analyst evaluations; handles client disconnect aborts.
3. **Provider Timeout Guards (Gemini & Embeddings)**: Wraps `GeminiAdapter.call` (`generateContent`) and `GeminiEmbeddingProvider.embed` (`embedContent`) with explicit timeouts (30-60s) to guarantee calls never hang indefinitely on stalled network sockets.
4. **Immediate 429 Failover Recovery & Simulation Fix**: Restores immediate failover on 429 rate limits in `Agent.run` when fallback providers are available, resolving the regression in `test-multi-app-simulation.ts`.
5. **SwarmClient Error Handling**: Parses `swarm_error` events in `SwarmClient.streamRemote` so remote errors are surfaced immediately rather than silently terminated.
6. **Robust Token Chunking**: Guards `createTokenChunks` in `profiler.ts` against single-line unformatted JSON/payloads exceeding token limits without newlines.

## Functional Requirements
- **FR-1: Real-Time SSE Stream Consumption in UI (`App.tsx`)**:
  - Connect to `/api/swarm/stream` using `ReadableStream` reader.
  - Append incoming `swarm_event` items to `events` in real-time so `SwarmEventTimeline` renders immediately without waiting for synthesis.
  - Set `finalAnalysis` upon receiving `swarm_complete`.
  - Provide an interactive "Cancel Analysis" button that triggers `AbortController.abort()` and safely resets `loading` to false.
  - Gracefully handle `swarm_error` or network failures with error banner and state cleanup.
- **FR-2: Server-Side Keep-Alive & Connection Lifecycle (`src/swarm/server.ts`)**:
  - Send an SSE comment `:keepalive\n\n` every 15 seconds to prevent browser and reverse proxy dropouts.
  - Clean up intervals and listeners on `req.on('close')`.
- **FR-3: Timeout Protection for Gemini & Vector Embeddings**:
  - Implement timeout guard in `GeminiAdapter.call` using `options.timeoutMs || 45000`.
  - Implement timeout in `GeminiEmbeddingProvider.embed` with fallback to `DeterministicLocalEmbeddingProvider` on timeout/network failure.
- **FR-4: Immediate Failover on 429 Rate Limits (`src/swarm/agent.ts`)**:
  - When `isFailoverEligible` is met (429, RATE_LIMIT, 502, 503, timeout) and `hasNextProvider` is true, immediately trigger failover to the backup provider without waiting through 4 retries and exponential delays.
  - Fixes `test-multi-app-simulation.ts` regression where Groq 429 failed to failover to OpenRouter.
- **FR-5: SwarmClient Stream Error Propagation (`src/swarm/client.ts`)**:
  - In `streamRemote`, listen for `swarm_error` events and yield/throw appropriate error payload so caller is immediately notified.
- **FR-6: Profiler Chunking Guard (`src/swarm/profiler.ts`)**:
  - In `createTokenChunks`, slice ultra-long single lines exceeding `maxTokensPerChunk` to avoid massive token chunks on minified JSON payloads.

## Non-Functional Requirements
- **Responsiveness**: UI displays the first event within 500ms of launching a swarm.
- **Fault-Tolerance**: Swarm never hangs indefinitely under stalled network sockets or exhausted rate limits.
- **Test Coverage**: All test suites (`npm test`, Vitest, `test-multi-app-simulation.ts`, portable swarm, SSE tests) pass with 100% green status.

## Out of Scope
- Rewriting the core UI design or adding third-party UI libraries.

## Acceptance Criteria
- Clicking "Run Swarm" in the UI streams events progressively into the timeline in real time.
- A "Cancel" button allows the user to immediately abort execution.
- If an agent hits a 429 or timeout, failover occurs immediately when fallbacks exist.
- Gemini calls cannot hang beyond their configured timeout.
- `npm test` runs cleanly and all test suites pass including `test-multi-app-simulation.ts`.
