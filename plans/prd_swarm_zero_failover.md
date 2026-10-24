# PRD: Zero-Failover & High-Throughput Swarm Engine for Massive Datasets

## 1. Overview & Objectives

### 1.1 Objective
Eliminate model failover cascades, rate-limit drops (HTTP 429/503), and circuit breaker lockouts across heterogeneous provider tiers (Groq, Gemini, Mistral, OpenRouter, NVIDIA, Cloudflare) when processing high-volume structured payloads (>500KB, 20+ chunks).

### 1.2 Success Metrics (KPIs)
- **Zero Premature Failovers**: 0 failovers caused by token budget estimation errors or arbitrary wait caps (`MAX_BUDGET_WAIT_MS`).
- **Zero False Circuit Tripping**: Circuit breaker only opens on persistent fatal 5xx or exhausted daily quotas, never on transient 429 bursts with short `Retry-After` headers.
- **Provider Capacity Alignment**: 100% adherence of chunk sizes to target provider `maxInputTokens`.
- **Token Estimation Precision**: Token estimation error margin reduced from ±45% to <±8% on structured JSON and log streams.

---

## 2. Problem Statement & Root Cause Analysis

### 2.1 Static & Underestimated Token Profiling
- **Current State**: `src/swarm/providers/limiter.ts:57` calls `TokenEstimator.estimateFromChars(chars)` (`chars / 4`).
- **Impact**: Structured JSON, telemetry logs, and code average 1 token per 2.0–2.8 characters. Underestimating by 30–50% causes token bursts that exceed provider limits (e.g., Groq's 7,000 TPM limit), triggering 429s.

### 2.2 Hardcoded Wait Cap Triggering Failover Cascade
- **Current State**: `src/swarm/providers/limiter.ts:280-286` throws `LimiterSkipError` whenever `budgetWaitMs(provider, estTokens) > MAX_BUDGET_WAIT_MS` (10,000ms).
- **Impact**: When Groq consumes its 7,000 TPM, the required wait is ~50–60s until the sliding window clears. Because 50s > 10s, `agent.ts:126` immediately marks the provider as skipped and triggers a cascade through all backup providers.

### 2.3 Indiscriminate Circuit Breaker Tripping on 429s
- **Current State**: `src/swarm/providers/limiter.ts:215-220` groups `rate_or_server` (429 and 5xx) together.
- **Impact**: 3 burst 429 responses trip `BREAKER_FAILURE_THRESHOLD = 3`, locking the provider out for 5 minutes (`BREAKER_OPEN_MS = 300_000ms`), even if the provider returned a 2-second `Retry-After`.

### 2.4 Unthrottled Wave Concurrency in Cluster Pipeline
- **Current State**: `src/swarm/engine/clusterPipeline.ts:449-453` slices chunk tasks into waves and dispatches them via `Promise.all` without pre-flight token budget validation for the wave.
- **Impact**: Multi-analyst waves overwhelm single-concurrency / low-TPM providers at wave initiation.

---

## 3. Scope & Architectural Constraints

### 3.1 In Scope
1. Dynamic, syntax-aware token estimator for JSON and structured text.
2. Centralized predictive token backpressure with queueing in `ProviderLimiter`.
3. Smart 429 exponential backoff with jitter honoring `Retry-After` headers.
4. Provider-specific dynamic chunk sizing adhering to `PROVIDER_LIMITS[provider].maxInputTokens`.
5. Context-capacity pre-flight routing in `SpecialistAffinityRouter`.
6. Hierarchical map-reduce reduction tier in `clusterPipeline.ts` for chunk counts > 6.

### 3.2 Out of Scope / Strict Constraints
- **Zero Model Blacklisting**: Strict adherence to `MEMORY.md`: never ban, blacklist, or silently substitute user-configured models.
- **Zero Removal of User Models**: User-specified model strings must pass through `isValidModel` without modification.

---

## 4. Module Specifications

### Module 1: Syntax-Aware Token Estimator
- **Target Files**: `src/swarm/compression/tokenEstimator.ts`, `src/swarm/providers/limiter.ts`
- **Functional Requirements**:
  1. Add `estimatePayloadTokens(input: string | object | unknown): number` to `TokenEstimator`:
     - Fast regex parsing distinguishing punctuation/keys (`len / 2.2`), uppercase/identifiers (`len / 2.8`), and natural language (`len / 4.0`).
     - Apply a 1.12x safety buffer for JSON data.
  2. Update `src/swarm/providers/limiter.ts` so `estimateTokens` accepts payload strings/objects and delegates to `estimatePayloadTokens`.
  3. Ensure `LimiterRunRequest` receives accurate token counts prior to `budgetWaitMs`.

### Module 2: Resilient Token Backpressure & Circuit Breaker Isolation
- **Target Files**: `src/swarm/providers/limiter.ts`, `src/swarm/agent.ts`
- **Functional Requirements**:
  1. **Configurable Budget Wait**: Introduce `maxBudgetWaitMs` in `ProviderLimitConfig` (default 65,000ms for strict backpressure mode, 10,000ms for interactive fail-fast mode).
  2. **Controlled Queueing**: When `budgetWaitMs > 0` but `<= maxBudgetWaitMs`, await `sleep(wait)` rather than throwing `LimiterSkipError`.
  3. **429 Circuit Isolation**: Split `classifyProviderError` into `rate_limit` (429) and `server_error` (5xx). A 429 response must NOT increment `consecutiveFailures` toward circuit breaker trip unless all retries fail.
  4. **Retry-After Parsing**: In provider adapters (`groq.ts`, `gemini.ts`, `adapter.ts`), parse `retry-after` and `x-ratelimit-reset` headers. If `retry-after <= 8000ms`, sleep `retry-after + randomJitter(200-800ms)` and retry the primary target before failing over.

### Module 3: Dynamic Provider-Aware Chunk Sizing
- **Target Files**: `src/swarm/engine/clusterPipeline.ts`, `src/swarm/engine/analystExecution.ts`
- **Functional Requirements**:
  1. Read `PROVIDER_LIMITS[assignedProvider].maxInputTokens` during chunk assignment.
  2. Calculate dynamic chunk threshold: `targetChunkTokens = Math.min(providerMaxInputTokens * 0.75, 6000)`.
  3. Split or merge payload segments to guarantee that no chunk exceeds the assigned model's input budget.

### Module 4: Pre-Flight Wave Budget Pacing
- **Target Files**: `src/swarm/engine/clusterPipeline.ts`
- **Functional Requirements**:
  1. Before dispatching `Promise.all(waveItems.map(...))`, sum the estimated tokens of all items in the wave grouped by target provider.
  2. Query `globalProviderLimiter.budgetWaitMs(provider, waveSumTokens)`.
  3. If wait is required, pace chunk dispatches sequentially or introduce micro-delays between wave tasks to prevent simultaneous TPM consumption.

### Module 5: Context-Capacity Routing Affinity
- **Target Files**: `src/swarm/router.ts`
- **Functional Requirements**:
  1. In `SpecialistAffinityRouter`, evaluate payload token weight before evaluating role affinity.
  2. If chunk estimated tokens > 1,500, filter out providers with `maxInputTokens <= 1500` (e.g. Groq) from candidate pool.
  3. Route high-volume chunks to high-capacity providers (Gemini, NVIDIA) and reserve Groq for synthesis, routing, and short scorecards.

### Module 6: Hierarchical Map-Reduce Synthesis
- **Target Files**: `src/swarm/engine/clusterPipeline.ts:462-530`
- **Functional Requirements**:
  1. When chunk count > 6, construct a 2-tier tree reduction:
     - Sub-managers synthesize batches of 3–4 analyst chunk reports into intermediate `ClusterDigest` summaries.
     - The root manager synthesizes only the resulting `ClusterDigests`.
  2. Enforce strict token capping on intermediate summaries to guarantee root manager input remains under 4,000 tokens.

---

## 5. Verification & Acceptance Criteria

| ID | Test Scenario | Acceptance Criteria |
|---|---|---|
| **AC-01** | Accurate Token Estimation | Token count for dense JSON payload is within ±8% of actual BPE tokenizer count. |
| **AC-02** | Zero Premature Failover on Groq | Ingesting 15,000 tokens on Groq (7,000 TPM limit) pauses execution via backpressure queue and completes without failover. |
| **AC-03** | 429 Retry-After Handling | Simulated 429 with `Retry-After: 3` pauses for 3s + jitter, successfully retries, and does not open circuit breaker. |
| **AC-04** | Dynamic Chunk Allocation | Chunks assigned to Groq do not exceed 1,500 tokens; chunks assigned to Gemini utilize up to 6,000 tokens. |
| **AC-05** | Hierarchical Map-Reduce | Processing 20 chunks produces intermediate digests; root manager prompt does not exceed context bounds. |
| **AC-06** | Regression Test Suite | All existing tests pass (`bun test` / `npm test`). |
