# Ultragoal Brief: Full Codebase Modularization & Monolith Deconstruction (2026-10-02)

## Objective
Fully modularize and deconstruct the monolithic files in the codebase, cutting them down into single-responsibility, highly maintainable, and testable modules while preserving 100% backward compatibility, zero new runtime dependencies, and flawless dual ESM/CJS builds.

## Identified Monoliths
1. **`src/swarm/engine/index.ts`** (1,969 lines, 111 KB): Single massive orchestrator containing cluster aggregation, manager synthesis, verification critic lifecycle, and feedback loops.
2. **`src/swarm/memory.ts`** (1,676 lines, 70 KB): Bundles embedding providers, sparse tokenization, RRF retrieval profiles, file-based snapshot persistence, consolidation, and memory indexing.
3. **`src/components/optimization/OptimizationRunner.tsx`** (1,571 lines, 89 KB): Combines scoring logic, consensus calculation, model quarantine, caching, combination runners, and multiple UI components in a single React file.
4. **`src/swarm/loadBalancer.ts`** (1,109 lines, 42 KB): Bundles 5 distinct systems (`AdaptiveLoadBalancer`, `TokenBudgetManager`, `NodeCapacityManager`, `SpecialistCapabilityProfiler`, `SpecialistAffinityRouter`).
5. **`src/swarm/feedback.ts`** (962 lines, 35 KB): Bundles 5 distinct systems (`PolicyOptimizer`, `ConceptDriftDetector`, `SwarmKnowledgeRepository`, `ContinuousFeedbackEngine`, `AnalystLedger`).

## Constraints & Architectural Boundaries
- **Preserve Package Subpath Exports**: `package.json` exports (`./engine`, `./memory`, `./loadBalancer`, `./feedback`, `./optimization`, etc.) and `scripts/build-swarm.ts` must continue to resolve cleanly to the same bundle targets.
- **Zero Breakage of Global Singletons**: Singletons like `globalFeedbackEngine`, `globalLoadBalancer`, `analystLedger`, `globalSpecialistProfiler`, `globalMemoryCortex` must remain accessible at their standard import paths.
- **Dual ESM & CommonJS Bundling**: All dynamic `import('no' + 'de:fs')` and `import('no' + 'de:path')` conventions for Cloudflare Pages / Workers Edge safety must be maintained.
- **Strict Verification**: Every goal must pass `tsc --noEmit`, full Vitest suite (535+ tests), and `npm test` (portable, simulation, dist imports, CLI, and SSE streaming server).

## Micro-Goal Breakdown
1. **`goal-1-modularize-engine-monolith`**:
   Extract `clusterPipeline.ts`, `synthesisPipeline.ts`, `verificationPipeline.ts`, and `learningPipeline.ts` from `src/swarm/engine/index.ts`, reducing `index.ts` from ~2,000 lines to a clean coordinator under 400 lines.
2. **`goal-2-modularize-memory-and-embeddings`**:
   Decompose `src/swarm/memory.ts` into `src/swarm/memory/` (`embeddings.ts`, `tokenizer.ts`, `cortex.ts`, `types.ts`), keeping `memory.ts` as a clean facade re-exporting all symbols.
3. **`goal-3-modularize-load-balancer-and-feedback`**:
   Decompose `src/swarm/loadBalancer.ts` and `src/swarm/feedback.ts` into single-responsibility submodules while preserving global singletons and backward-compatible re-exports.
4. **`goal-4-modularize-optimization-runner-ui-and-verify`**:
   Extract scoring algorithms, caching, and subcomponents from `src/components/optimization/OptimizationRunner.tsx`; execute full test suite, verify clean TypeScript types, build production bundles, and record efficiency improvements.
