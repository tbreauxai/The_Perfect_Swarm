# Ultragoal Brief: Multi-App Autonomous Learning Swarm & Free-Tier Optimization

## Core Objective
Transform the codebase into a battle-tested, zero-leak foundation for a modular AI swarm deployable across multiple independent applications, equipped with continuous learning via Qdrant and high resilience against free-tier API quotas, rate limits (429), timeouts, and model quirks.

## Constraints & Architecture Boundaries
1. **File Structure & Clean Package Boundary**:
   - The swarm core must live completely inside `src/swarm/` (or dedicated package) with its own memory, routing, lifecycle, state, schemas, and failover engine.
   - Zero dependency leakage: external applications importing from `./src/swarm` or `@swarm/core` must not require React, Vite, Lucide, or Express.
2. **Free-Tier AI Resilience**:
   - Free APIs (Groq, OpenRouter, Mistral, GitHub, Gemini) suffer from tight RPM/TPM quotas, frequent 429s, latency spikes, and missing headers.
   - The swarm must support provider failover cascades (if Provider A returns 429/503/timeout, automatically fail over to Provider B/C in user's configured key pool).
   - All network requests must feature strict timeouts via `AbortController` (no hanging promises).
   - Reasoning models (e.g. DeepSeek-R1, Llama-3.3) emitting `<think>...</think>` tags must be parsed cleanly before JSON validation.
3. **Qdrant Continuous Learning Cortex**:
   - Multi-app namespacing: isolate memories by `appId` without requiring separate clusters.
   - Feedback & Reinforcement: support rating past analyses (`qualityRating`), allowing the swarm to learn which outputs were verified or approved.
   - Semantic deduplication: avoid storing redundant vectors when repeated similar tasks run (upsert weight/reinforce if cosine similarity > 0.92).
   - Compound payload indexing: create payload indexes for `appId`, `domain`, and `qualityRating`.
   - Exemplary Few-Shot Learning: retrieve top-rated historical executions to inject as few-shot exemplars during planning and analysis.
4. **Verification**:
   - Zero TypeScript compilation errors (`tsc --noEmit`).
   - Clean production bundle (`npm run build`).
   - Executable simulation proving multi-app isolation, failover cascade, and reinforcement learning under native `node --experimental-strip-types`.
