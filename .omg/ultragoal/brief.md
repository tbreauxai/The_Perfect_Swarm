# Ultragoal Brief: Semantic Action/Plan Cache Layer for agent-retriever

## Objective
Implement a Semantic "Action/Plan Cache" Layer for the `agent-retriever` / `MemoryCortex` pipeline to reduce Qdrant vector search latency from 45ms to ~2ms without serving stale live odds, elevating repetitive query cache hit ratio from 0% to 35-45%.

## Current State vs. Target State
- **Current State**: Cache hit ratio is 0%. Every incoming query executes an expensive 45ms Qdrant dense/sparse hybrid vector search and LLM action planning pass.
- **Target State**: 35-45% cache hit ratio for repetitive queries, achieving ~2ms retrieval latency on cache hits while guaranteeing 100% fresh, live odds data.

## Core Requirements & Architecture Boundaries
1. **Interceptor Placement**:
   - Deployed directly before the Qdrant dense/sparse search execution (`MemoryCortex.retrieve` / `SwarmEngine` Step 3).
2. **LRU + Semantic Index**:
   - High-performance in-memory LRU cache with sub-linear vector index (e.g. VP-Tree / Cosine metric).
   - High similarity threshold (> 0.96) matching user query embeddings.
3. **No Stale Live Odds (Critical Invariant)**:
   - NEVER cache final text responses, rendered UI dashboards, or volatile live odds values.
   - Cache ONLY the structured "Action Plan":
     - `intent`: Classified query goal (e.g. `market_odds_lookup`, `implied_probability_calc`, `arbitrage_scan`)
     - `entities`: Extracted parameters (e.g. `homeTeam`, `awayTeam`, `sport`, `marketType`, `format`)
     - `toolExecutionSteps`: Deterministic tool calls / API fetch actions (e.g. `probability_odds_converter`, `live_odds_api`)
4. **Hit & Miss Workflows**:
   - **Cache Hit (> 0.96)**: Bypass the 45ms Qdrant search and LLM planning; retrieve the cached Action Plan; dynamically execute live data fetches with extracted entities.
   - **Cache Miss**: Execute Qdrant vector retrieval and LLM planning; extract Intent, Entities, and Action Plan; cache Action Plan against query embedding for future identical intents.
5. **Runtime Constraints**:
   - Zero external runtime dependencies; pure TypeScript compatible with Node.js, Bun, and Edge runtimes.
   - 100% test coverage and telemetry metrics integration (`GET /api/swarm/metrics`).
