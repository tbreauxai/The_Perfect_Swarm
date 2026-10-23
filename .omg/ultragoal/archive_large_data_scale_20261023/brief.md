# Ultragoal Brief: Large Data Scale Audit & Swarm Resilience Hardening

## Track ID
`large_data_scale_20261023`

## Core Objective
Audit the Swarm engine and backend data pipeline to ensure reliable processing of large structured datasets (CSV/JSON up to 5-10MB / 50k-100k+ rows) and high-volume workloads without runtime errors, provider context length violations, token-per-minute (TPM) throttling, silent chunk truncation, or manager synthesis memory crashes.

## Key Phases
1. **Phase 1: High-Volume Payload Profiling & Zero-Loss Chunking**: Remove 8-chunk / 500k char silent middle truncation, add structure-aware CSV/JSON chunking with header repetition.
2. **Phase 2: Hierarchical Map-Reduce Batching & Specialist Wave Scheduling**: Implement wave scheduling for 10+ chunks across specialists with intermediate cluster digest rollups.
3. **Phase 3: Adaptive Manager Synthesis & Context Ceiling Protection**: Automatically trigger recursive synthesis/compression when reports approach manager token ceilings; ensure strict fail-safe token trimming.
4. **Phase 4: Provider TPM Rate Pacing & Express Ingestion Hardening**: Dynamic dispatch delay windows for rate-limited providers (Groq/Mistral) and 10MB Express body parser limits.
5. **Phase 5: End-to-End Stress Verification & Regression Suite**: 50k-row end-to-end stress simulation test + full test/lint verification.

## Non-Goals & Boundaries
- Adding external database backends beyond Qdrant.
- Client UI cosmetic changes.
