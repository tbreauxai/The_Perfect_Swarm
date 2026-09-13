# Ultragoal Brief: Phase 2 - Continuous Learning Cortex, Cross-Provider Critic & Shared Memory Optimization

## Core Objective
Refine and harden `@perfect-swarm/core` into an adaptive, self-improving multi-agent intelligence runtime capable of learning across target applications using free-tier LLM APIs and hybrid Qdrant/in-memory vector memory.

## Architectural Audit & Focus Areas
1. **Engine Memory Binding & Shared Knowledge**:
   - Bind `MemoryCortex` unconditionally in `src/swarm/engine.ts` so offline/in-memory hybrid RRF vector search and exemplar distillation execute even when `QDRANT_URL` is omitted.
   - Accept injected `cortex` in `SwarmWorkflowParams` and maintain process-level singletons per `appId` to preserve learning across workflow runs.
   - Support `includeShared: true` in engine retrieval so consumer apps inherit foundational domain knowledge.
2. **AI Structure & RLAIF Cross-Critique**:
   - Prefer cross-provider Critic agents (e.g. Gemini critic for Groq analyst) to eliminate LLM self-affirmation bias.
   - Record fast-path and low-complexity executions into the learning cortex to establish positive baselines.
3. **Qdrant Vector Cortex & Maintenance**:
   - Add automated memory consolidation (pruning `qualityRating < 0.40` and deduplicating clusters) on periodic intervals or item thresholds.
   - Support customizable dense-to-sparse weights in hybrid Reciprocal Rank Fusion (RRF).

## Verification Criteria
- `tsc --noEmit` passes with 0 errors.
- `npm run build` succeeds (client + dual swarm ESM/CJS bundles).
- `npm test` passes all suites (portable, simulation, dist, cli, server, and multi-run learning tests).
