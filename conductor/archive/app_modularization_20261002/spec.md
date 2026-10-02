# Specification: Full Application Modularization

## 1. Overview
Deconstruct every monolithic file (>500–1,400 lines) across the `@perfect-swarm/core` engine and React web client into single-responsibility, highly maintainable submodules. Guarantee zero broken imports, 100% backward compatibility for subpath exports, zero added runtime dependencies, and strict test and build verification.

## 2. Scope & Target Files
- **Optimization Engine**: `src/swarm/optimization.ts` (1,056 lines) -> `src/swarm/optimization/`
- **Vector Index Engine**: `src/swarm/vectorIndex.ts` (990 lines) -> `src/swarm/vectorIndex/`
- **Tiered Cache Engine**: `src/swarm/tieredCache.ts` (911 lines) -> `src/swarm/tieredCache/`
- **Experiment Engine**: `src/swarm/experiment.ts` (882 lines) -> `src/swarm/experiment/`
- **Profiler Engine**: `src/swarm/profiler.ts` (874 lines) -> `src/swarm/profiler/`
- **Scheduler Engine**: `src/swarm/scheduler.ts` (892 lines) -> `src/swarm/scheduler/`
- **Communication Layer**: `src/swarm/communication.ts` (869 lines) -> `src/swarm/communication/`
- **Compression Engine**: `src/swarm/compression.ts` (772 lines) -> `src/swarm/compression/`
- **Speculative Execution**: `src/swarm/speculative.ts` (746 lines) -> `src/swarm/speculative/`
- **Memory Cortex Pipeline**: `src/swarm/memory/cortex.ts` (1,406 lines) -> `src/swarm/memory/`
- **Cache & Health Engines**: `src/swarm/cache.ts` (644 lines) & `src/swarm/health.ts` (621 lines) -> `src/swarm/cache/`, `src/swarm/health/`
- **Builtin Tools**: `src/swarm/tools/builtin.ts` (859 lines) -> `src/swarm/tools/`
- **Server Module**: `src/swarm/server.ts` (678 lines) -> `src/swarm/server/`
- **Parser & Coordination**: `src/swarm/parser.ts` (560 lines) & `src/swarm/coordination.ts` (511 lines) -> `src/swarm/parser/`, `src/swarm/coordination/`
- **Hierarchy Engine**: `src/swarm/hierarchy.ts` (539 lines) -> `src/swarm/hierarchy/`
- **Cluster Pipeline**: `src/swarm/engine/clusterPipeline.ts` (857 lines) -> `src/swarm/engine/`
- **Application Shell**: `src/App.tsx` (525 lines) -> `src/hooks/useSwarmSettings.ts`, `src/hooks/useSwarmExecution.ts`, `src/App.tsx` (271 lines)
- **Model Optimizer UI**: `src/components/optimization/OptimizationRunner.tsx` (1,095 lines) -> `useOptimizationRunner.ts`, `optimizationGrading.ts`, `types.ts`, `OptimizationRunner.tsx` (134 lines)

## 3. Success Criteria
- 0 TypeScript compilation errors (`npx tsc --noEmit`).
- 545/545 unit and integration tests passing (`npx vitest run`).
- Full client production build passes (`npm run build:client`).
- Swarm dual ESM/CJS library build and `.d.ts` generation passes (`npm run build:swarm`).
- All CLI, simulation, and SSE streaming server tests pass (`npm test`).
- Clean git status with all changes committed and pushed to `main`.
