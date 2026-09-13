# Ultragoal Brief: Swarm Dynamic Pre-Filtering, Hierarchical Caching & Adaptive Load Balancing

## Core Objective
Maximize swarm efficiency, minimize token waste, and eliminate latency bottlenecks across free-tier AI APIs through:
1. Low-complexity intent pre-filtering and fast-path short-circuiting to bypass heavy sub-modules for trivial tasks.
2. Hierarchical communication layers (L1 Triage -> L2 Specialist Analysts -> L3 Manager Synthesis) with structured deterministic payload caching to prevent context window drift and broadcast overhead.
3. Real-time adaptive load balancing leveraging latency exponential moving averages (EMA), in-flight concurrency tracking, and continuous health feedback loops.

## Constraints & Architecture Boundaries
1. **Zero-Leak Swarm Architecture**:
   - All modules (`cache.ts`, `hierarchy.ts`, `loadBalancer.ts`, enhancements to `router.ts`) must reside in `src/swarm/`.
   - Zero React/Vite/Express dependencies in `src/swarm/`.
   - Node native type stripping compliance (`node --experimental-strip-types`): no constructor parameter properties, no TypeScript enums, explicit type imports.
2. **Deterministic Payload Caching**:
   - Implement memory-bounded LRU + TTL cache with SHA-256 / Murmur content hashing of task + data payload.
   - Prevent context window drift and redundant token expenditure for identical or repetitive analyses.
3. **Intent Pre-Filtering & Fast-Path Routing**:
   - Short-circuit tasks under 25 tokens or matching basic metadata queries directly to a single fast node, bypassing data profiling, chunk splitting, Qdrant cortex queries, and critique lifecycle loops.
4. **Adaptive Load Balancing & Real-Time Capacity Tracking**:
   - Maintain rolling latency EMAs per provider.
   - Track active in-flight requests per provider to prevent free-tier concurrency throttling.
   - Auto-downweight providers exhibiting recent 429 rate limits or latency spikes.
5. **Verification**:
   - Clean `tsc --noEmit` and `vite build`.
   - Automated benchmarking and validation test suite runnable via `npm test`.
