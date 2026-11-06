# Ultragoal Brief: Deductive Reasoning & Intelligence Implementation Plan

## Objective
Implement the 6 accepted reasoning and intelligence optimizations: Dynamic Hypothesis/Refutation, Meta-Learning Failure Reflection, Adversarial Red-Teaming, Ensemble Confidence Calibration, Context-Aware Emergency Fallback, and Zero-Cost Thinking Tag Harvesting, verify all test suites, and clear `todo.md`.

## Architecture Boundaries & Phases
1. **Phase 1: Zero-Inference Harvesting & Adversarial Dialectic**
   - Extract thinking tags (`<think>`, `<reasoning>`, `<thought>`, `[THOUGHT]`) in `repairJson.ts` and attach to `metadata.reasoningTraces`.
   - Add `RedTeamAnalyst` role and instructions to default analyst pool in `constants.ts`.
   - Calculate sample variance in `consensusPipeline.ts`, emit `[CONTESTED_CONSENSUS]` warning, and clamp manager confidence when variance > threshold.
2. **Phase 2: Dialectic Synthesis & Resilient Fallback Degradation**
   - Add `primaryHypothesis` and `counterHypothesis` to analyst schema and register into `HypothesisValidationLayer` in `coordinationPipeline.ts`.
   - Generate structured `Debate Digest` into `compileSynthesisPrompt`.
   - Context-aware emergency synthesis fallback in `partialResult.ts` with 200-token cap before falling back to single analyst.
3. **Phase 3: Asynchronous Meta-Learning & Failure Reflection**
   - Create `src/swarm/feedback/offlineReflection.ts` with non-blocking failure reflection generator on loss outcomes.
   - Upsert generated failure reflection rule and reason into `MemoryCortex.upsertGradedLesson()`.
4. **Phase 4: Verification Gateways & Todo Clearance**
   - `npm run lint`, unit tests, offlineReflection tests, full unit suite, `npm run build`, and clear `todo.md`.
