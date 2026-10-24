# Ultragoal Brief: Zero-Failover & High-Throughput Swarm Engine for Massive Datasets

## Core Objective
Eliminate model failover cascades, rate-limit drops (HTTP 429/503), and circuit breaker lockouts across heterogeneous provider tiers (Groq, Gemini, Mistral, OpenRouter, NVIDIA, Cloudflare) when processing high-volume structured payloads (>500KB, 20+ chunks) as defined in [plans/prd_swarm_zero_failover.md](file:///C:/Dev/Workspaces/The_Perfect_Swarm/plans/prd_swarm_zero_failover.md).

## Key Success Metrics (KPIs)
- **Zero Premature Failovers**: 0 failovers caused by token budget estimation errors or arbitrary wait caps (`MAX_BUDGET_WAIT_MS`).
- **Zero False Circuit Tripping**: Circuit breaker only opens on persistent fatal 5xx or exhausted daily quotas, never on transient 429 bursts with short `Retry-After` headers.
- **Provider Capacity Alignment**: 100% adherence of chunk sizes to target provider `maxInputTokens`.
- **Token Estimation Precision**: Token estimation error margin reduced from ±45% to <±8% on structured JSON and log streams.

## Scope & Micro-Goals
1. **Goal 1: Syntax-Aware Token Estimator (`goal-1-token-estimator`)**:
   - Add `estimatePayloadTokens(input: string | object | unknown): number` to `TokenEstimator`.
   - Fast regex heuristics distinguishing punctuation/keys (`len / 2.2`), uppercase/identifiers (`len / 2.8`), and natural language (`len / 4.0`) with 1.12x JSON safety buffer.
   - Update `src/swarm/providers/limiter.ts` so `estimateTokens` accepts payload strings/objects and delegates to `estimatePayloadTokens`.
   - Update `LimiterRunRequest` token estimation accuracy.
   - Verification: AC-01 (±8% token precision against dense JSON payloads).

2. **Goal 2: Resilient Token Backpressure & Circuit Breaker Isolation (`goal-2-token-backpressure-circuit-isolation`)**:
   - Add configurable `maxBudgetWaitMs` in `ProviderLimitConfig` (default 65,000ms for strict backpressure, 10,000ms for interactive fail-fast).
   - Await `sleep(wait)` when `budgetWaitMs > 0` but `<= maxBudgetWaitMs` rather than throwing `LimiterSkipError`.
   - Split `classifyProviderError` into `rate_limit` (429) vs `server_error` (5xx). Transient 429s must NOT trip breaker unless all retries fail.
   - Parse `retry-after` and `x-ratelimit-reset` in provider adapters (`groq.ts`, `gemini.ts`, `adapter.ts`); sleep `retry-after + randomJitter(200-800ms)` and retry before failing over.
   - Verification: AC-02, AC-03 (zero premature failover under Groq 7,000 TPM limit, 429 Retry-After handling).

3. **Goal 3: Dynamic Provider-Aware Chunk Sizing (`goal-3-dynamic-chunk-sizing`)**:
   - In `clusterPipeline.ts` & `analystExecution.ts`, read `PROVIDER_LIMITS[assignedProvider].maxInputTokens`.
   - Calculate dynamic chunk threshold: `targetChunkTokens = Math.min(providerMaxInputTokens * 0.75, 6000)`.
   - Guarantee no chunk exceeds assigned model's input budget.
   - Verification: AC-04 (Groq <= 1,500 tokens, Gemini <= 6,000 tokens).

4. **Goal 4: Pre-Flight Wave Budget Pacing (`goal-4-wave-budget-pacing`)**:
   - In `clusterPipeline.ts`, calculate sum of estimated tokens across wave items grouped by target provider.
   - Query `globalProviderLimiter.budgetWaitMs(provider, waveSumTokens)`.
   - Pace chunk dispatches sequentially or introduce micro-delays between tasks to avoid simultaneous TPM consumption.

5. **Goal 5: Context-Capacity Routing Affinity (`goal-5-capacity-routing-affinity`)**:
   - In `SpecialistAffinityRouter` (`src/swarm/router.ts`), evaluate payload token weight before evaluating role affinity.
   - Filter out low-capacity providers (`maxInputTokens <= 1500`) when chunk tokens > 1,500.
   - Route high-volume chunks to high-capacity providers (Gemini, NVIDIA) and reserve Groq for synthesis, routing, and short scorecards.

6. **Goal 6: Hierarchical Map-Reduce Synthesis & End-to-End Verification (`goal-6-hierarchical-map-reduce-and-verification`)**:
   - In `clusterPipeline.ts`, build 2-tier tree reduction for chunk count > 6: sub-managers synthesize batches of 3-4 analyst chunk reports into intermediate `ClusterDigest` summaries, then root manager synthesizes digests.
   - Enforce strict token capping on intermediate summaries (< 4,000 tokens).
   - Verification: AC-05, AC-06 (`npm test`, `npm run lint`, full regression suite and benchmark simulation).

## Architectural Invariants & Constraints
- **Zero Model Blacklisting**: Never ban, blacklist, or silently substitute user-configured models (`MEMORY.md`).
- **Zero Removal of User Models**: User-specified model strings must pass through `isValidModel` without modification.
- **Zero Test Regressions**: All existing unit and portable test suites must pass without regression.
