# Ultragoal Brief: Swarm Learning Persistence Qdrant UUIDv5 & Non-Zero Vector

## Objective
In `src/swarm/learning-persistence.ts`, convert each text ID (`ledger:`, `profile:`, `policy:gen:`) into a deterministic UUIDv5 so Qdrant accepts valid UUID point IDs without Bad Request errors, while preserving the original key in the point payload. Replace zero-filled dummy vectors with non-zero vectors for Cosine distance compatibility.

## Core Requirements & Architecture Constraints
1. **UUIDv5 Conversion**:
   - RFC 4122 compliant UUIDv5 generation based on SHA-1 and a fixed namespace UUID.
   - Deterministic point ID mapping for `ledger:${key}`, `profile:${role}`, `policy:gen:${generation}` (and any text-based outcome IDs).
   - Preserve original keys in point payload (`key`, `role`, `generation`, `originalKey`/`pointKey`).
2. **Non-Zero Vectors**:
   - `dummyVector()` must return a non-zero vector of length `VECTOR_SIZE` (e.g. normalized unit vector) to ensure Cosine distance calculation is valid in Qdrant.
3. **Round-Trip Integrity**:
   - `loadAll()` and all restore functions (`AnalystLedger`, `SpecialistCapabilityProfiler`, `SwarmKnowledgeRepository`) must restore state accurately using payload keys.
4. **Verification**:
   - Targeted unit tests in `learning-persistence.test.ts` verifying UUID format, non-zero vectors, payload keys, and full restore.
   - Full suite verification: `npm run lint`, `npm run test:unit`, `npm run test:server`, `npm run build`.
