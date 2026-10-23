# Specification: Large Data Scale Audit & Swarm Resilience Hardening

## Overview
Audit the Swarm engine and backend data pipeline to ensure reliable processing of large structured datasets (CSV/JSON up to 5-10MB / 50k-100k+ rows) and high-volume workloads without runtime errors, provider context length violations, token-per-minute (TPM) throttling, silent chunk truncation, or manager synthesis memory crashes.

---

## Key Problem Vectors Identified in Code Audit

1. **Chunk Truncation & Middle Loss ([src/swarm/profiler/dataProfiler.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/profiler/dataProfiler.ts))**:
   - `DEFAULT_MAX_CHUNKS` defaults to 8 and `DEFAULT_MAX_CHARS` defaults to 500k. When a dataset exceeds 8 chunks, lines 85-98 silently drop intermediate chunks (`chunks.slice(0, maxChunks - 1)` + last chunk), losing up to 90% of the middle dataset.
   - Long lines (e.g. minified JSON or wide CSVs) are arbitrarily segmented at fixed character offsets without respecting tabular records or JSON object boundaries.

2. **Manager Synthesis Prompt Bloat ([src/swarm/engine/synthesisPipeline.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/engine/synthesisPipeline.ts))**:
   - In standard execution, all analyst reports across all chunks are joined into raw strings (`compiledReports`). When evaluating 8+ chunks across multiple analysts, `dynamicPrompt` easily balloons past 30k-100k tokens, instantly overflowing Groq (8k ceiling), Mistral (32k), or standard models with `context_length_exceeded`.
   - Compression is only executed if `settings?.compressionSettings?.enabled` is manually enabled; there is no automatic adaptive compression or hierarchical map-reduction when prompt size approaches provider context ceilings.

3. **Provider TPM Exhaustion & Concurrency Spikes ([src/swarm/engine/analystExecution.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/engine/analystExecution.ts), [src/swarm/engine/clusterPipeline.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/engine/clusterPipeline.ts))**:
   - Parallel execution waves fire multiple analyst calls simultaneously. On rate-limited providers (e.g. Groq 7,000 TPM / 30 RPM), speculative parallel runs trigger instant 429 cascades.
   - While Groq token fitting exists (`fitChunkToProvider`), chunks for other providers lack dynamic budget fitting against actual remaining token quotas.

4. **Express Ingestion & Memory Pressures ([src/swarm/server/app.ts](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/server/app.ts))**:
   - Request body parsers and event streams must sustain 10MB payloads without heap exhaustion or socket timeouts during extended multi-chunk runs.

---

## Functional Requirements

### 1. Zero-Loss Hierarchical Map-Reduce Data Chunking
- **Full-Data Ingestion**: Refactor `createTokenChunks` and `profileData` in [`dataProfiler.ts`](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/profiler/dataProfiler.ts) to support arbitrary-sized inputs without silent chunk truncation.
- **Hierarchical Wave Chunking**: For payloads producing > 8 chunks, implement hierarchical wave scheduling (partitioning chunks into sequential or staged reduction waves rather than dropping records).
- **Structure-Aware Segmentation**: Preserve line/record integrity for CSV (header preservation across chunks) and valid JSON boundaries.

### 2. Adaptive Synthesis Aggregation & Context Ceiling Protection
- **Automatic Multi-Tier Reduction**: When `compiledReports` token count approaches the target manager provider's input context limit, automatically apply recursive synthesis / cluster digest rollups before dispatching to the executive manager.
- **Fail-Safe Token Trimming**: Ensure `executeManagerSynthesis` in [`synthesisPipeline.ts`](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/engine/synthesisPipeline.ts) guarantees the final prompt never exceeds `maxInputTokens` of the selected manager model, auto-routing to fallback models or condensing reports with high fidelity.

### 3. Concurrency Throttling & Adaptive Provider Token Pacing
- **Dynamic Token & Rate Budgeting**: Enhance [`analystExecution.ts`](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/engine/analystExecution.ts) and [`clusterPipeline.ts`](file:///C:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/engine/clusterPipeline.ts) with adaptive dispatch windows to prevent concurrent TPM saturation on sensitive providers (Groq, Mistral, OpenRouter).
- **Graceful Degradation & Auto-Failover**: Maintain resilient failover whenever 429 or rate limits are encountered, preserving analyst findings and continuing the execution chain without halting the swarm.

### 4. End-to-End Stress Testing & Benchmark Validation
- Add automated high-volume stress tests validating:
  - 5MB+ / 50k+ row CSV payloads chunked and processed without data drop.
  - Multi-chunk synthesis runs with 10+ chunks completing without `context_length_exceeded`.
  - Rate-limit resilience under simulated tight TPM ceilings.

---

## Non-Functional Requirements
- **Determinism & Accuracy**: Zero silent dropping of user data chunks; all records must be assigned and analyzed.
- **Backward Compatibility**: Fully preserve all existing scorecard modes, morning judge workflows, and CLI/API contracts.
- **Performance**: Sub-10ms overhead for chunking, segmentation, and prompt budgeting logic.
- **Test Coverage**: >85% coverage on new chunking, hierarchical aggregation, and token-fitting modules.

---

## Acceptance Criteria
1. **Zero Truncation**: A 5MB/50k-row payload produces the full set of valid chunks without warning of discarded batches; headers are preserved on tabular chunks.
2. **Context Safety**: Manager synthesis prompt automatically scales and fits within the provider's token limits without throwing context-overflow errors, even with 16+ analyst reports.
3. **Provider Stability**: Swarm completes without unhandled 429 errors or failed seats under concurrent execution.
4. **Test Pass Rate**: `npm run test:unit`, `npm run test:portable`, and `npm run test:dist` pass with 100% success rate.
5. **Lint Cleanliness**: `npm run lint` (`tsc --noEmit`) passes with 0 errors.

---

## Out of Scope
- Adding new external database backends beyond Qdrant.
- Client UI redesign (changes restricted to engine, providers, and server scalability).
