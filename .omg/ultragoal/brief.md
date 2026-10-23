# Ultragoal Brief: Phase 1 Swarm Engine Resilience

**Objective:** Implement resilience and reliability improvements detailed in `todo.md` for scorecard validation, cluster pipeline analyst distribution, Groq adaptive token capping, and failover preservation.

## Core Objectives
1. **Relax & Auto-Repair Scorecards (`src/swarm/engine/scorecard.ts`):**
   - Enhance `validateScorecard` to auto-extract row IDs via regex (`/R\d+/g`) from unstructured markdown/prose if standard JSON parse fails.
   - If an analyst returns valid unstructured recommendations instead of raw JSON, preserve the text as a synthesized scorecard rather than dropping the seat.
2. **Prevent Analyst Dropping on Multi-Chunk (`src/swarm/engine/clusterPipeline.ts`):**
   - Ensure all active analysts evaluate the primary chunk or receive distributed chunk assignments with a minimum of 1 execution per analyst.
3. **Adaptive Token Capping & Fallback Chain (`src/swarm/providers/groq.ts` & `src/swarm/engine/agentResolution.ts`):**
   - Ensure `computeGroqScorecardMaxTokens` (and Groq adapter prompt handling) prunes input history before rejecting requests under the 7,000 TPM limit.
   - Never disable provider fallbacks on transient rate limits (429) or limiter skips even if `disableFallback` is toggled.
4. **Verification Gate:**
   - Pass `npm run lint` (`tsc --noEmit`) and all unit tests (`npm run test:unit`) with zero regressions.
