# Ultragoal Brief: Modular AI Swarm Foundation, Free-Tier AI & Qdrant Learning Cortex Optimization

## Core Objective
Optimize and harden the modular AI swarm codebase into a refined, zero-leak, portable foundation capable of continuous learning across multiple target applications. The swarm operates strictly on free-tier AI APIs (Gemini, Groq, OpenRouter, Mistral, GitHub) and Qdrant vector memory.

## Architectural Focus Areas
1. **File Structure & Portability**:
   - Relocate the core orchestration workflow into a headless, self-contained `src/swarm/engine.ts`.
   - Ensure `src/swarm/` has zero dependencies on client/UI/server code, allowing turnkey transplantation to any Node/Next.js/Bun/Express app.
   - Provide clean package.json subpath exports (`./engine`, `./profiler`, `./cache`, `./hierarchy`, etc.).
2. **AI Structure & Free-Tier Resilience**:
   - Align default model router mappings with guaranteed free-tier endpoints (e.g., auto `:free` suffix on OpenRouter, free-tier Mistral/Gemini quotas).
   - Implement autonomous reinforcement learning (RLAIF) connecting `AnalysisLifecycle` critic verification directly into `MemoryCortex` quality scores.
   - Robust structured JSON output recovery with fallback schema parsing.
3. **Qdrant Utilization & Continuous Learning Cortex**:
   - Complete Qdrant payload indexes (add `verified` bool index).
   - Implement ephemeral in-memory vector fallback when Qdrant is unavailable, enabling offline learning.
   - Implement automated memory pruning and consolidation for stale/low-rated memories.
   - Support cross-app shared learning baselines (`includeShared` option).

## Verification Criteria
- `tsc --noEmit` passes with 0 errors.
- `vite build` succeeds.
- Comprehensive portable and multi-app simulation tests verify headless engine execution, continuous learning score propagation, Qdrant fallback, and free-tier resilience under `node --experimental-strip-types`.
