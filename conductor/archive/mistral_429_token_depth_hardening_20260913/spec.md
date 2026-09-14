# Specification: Swarm Execution Hardening (Mistral 429 Transparency & Token Depth Allocation)

## Overview
Hardens swarm analyst execution against rate-limit hangs and token depth truncation:
1. **Mistral Rate Limit Transparency**: Transparently handles Mistral 429 (Code 1300) errors without misleading provider masquerading and without exponential backoff delays or 31-second mutex lock freezes.
2. **Token Depth & Budgeting**: Increases token budget allocations for complex metadata analysis and implements adaptive chunking to prevent truncated outputs.
3. **Empty Qdrant Telemetry**: Out of scope (confirmed test artifact).

## Functional Requirements
- **FR-1: Transparent Mistral Error Handling**:
  - When Mistral returns HTTP 429 (Code 1300 / Rate Limit), capture the structured error immediately and fail fast with a clear, honest diagnostic message (`[RATE_LIMIT_429] Mistral API rate limit exceeded (Code 1300)`).
  - Do not silently substitute alternate providers when an agent is explicitly configured for Mistral.
  - Optimize the 31-second hard mutex lock in `MistralAdapter` so that rate-limited requests fail fast without freezing subsequent executions.
- **FR-2: Increased Token Budget & Metadata Chunk Preservation**:
  - Upgrade default adapter `maxTokens` allocation (from 1500 to 3000+) to prevent premature token cutoffs.
  - Enhance `createTokenChunks` in `profiler.ts` to accommodate deep metadata payloads without cutting analysis short.

## Non-Functional Requirements
- **Performance & Latency**: Fail fast on quota limits without multi-minute hangs or locking other tasks.
- **Test Integrity**: Unit tests written in Vitest covering Mistral rate-limit diagnostics and token budgeting.
- **Zero Regression**: Maintain 100% pass rate across core test suites.

## Out of Scope
- Altering Qdrant schema or telemetry warnings due to empty test database state.

## Acceptance Criteria
- Mistral 429 / Code 1300 returns immediate transparent diagnostic feedback without hanging the pipeline or masquerading as another provider.
- Complex metadata analysis runs without truncation from token depth restrictions.
- All Vitest and core test suites pass 100%.
