# Track Specification: Bug - Qdrant Cortex Hang

## Overview
The UI stream stops updating when retrieving data from the memory cortex. Despite adding a 3-second timeout to Qdrant network requests, the swarm analysis still appears to hang indefinitely.

## Functional Requirements
- The UI stream must not stall silently at "Targeted Cortex Retrieval".
- Background requests to LLMs for embedding or inference must strictly respect timeout limits.
- Errors must be correctly surfaced to the UI stream as `swarm_error` instead of swallowing them, unless they are non-fatal (like memory retrieval fallback), in which case the failover must be instant (e.g., 3s max, not 30s + 30s).
- Evaluate `GeminiEmbeddingProvider.embed` which currently has a 30s timeout and is called twice sequentially during `Targeted Cortex Retrieval` (once for `retrieve` and once for `retrieveExemplars`), leading to up to 60 seconds of silent blocking.

## Out of Scope
- Re-architecting the entire server streaming protocol.
- Refactoring the entire `loadBalancer` logic unless directly tied to the hanging bug.

## Acceptance Criteria
- Triggering a swarm analysis correctly proceeds past "Targeted Cortex Retrieval" or throws an immediate error to the UI.
- The default `GeminiEmbeddingProvider` timeout is reduced or properly parallelized to prevent 60-second UI freezes.
- The `loadBalancer` fallback loop properly handles rejected promises without hanging `Promise.all` indefinitely.
