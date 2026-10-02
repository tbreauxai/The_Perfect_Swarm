# Implementation Plan: Full Application Modularization

## Phase 1: Core Engine Monoliths Deconstruction
- [x] Extract `OptimizationAgentCard`, `OptimizationErrorLog`, `OptimizationCombinationsTable`, `OptimizationHistoryTable` (`695778f`)
- [x] Deconstruct `src/swarm/optimization.ts` into `src/swarm/optimization/` submodules (`b6adcf4`)
- [x] Deconstruct `src/swarm/vectorIndex.ts` into `src/swarm/vectorIndex/` submodules (`d2ffc69`)
- [x] Deconstruct `src/swarm/tieredCache.ts` into `src/swarm/tieredCache/` submodules (`79ffa1a`)
- [x] Deconstruct `src/swarm/experiment.ts` into `src/swarm/experiment/` submodules (`e6890f7`)
- [x] Deconstruct `src/swarm/profiler.ts` into `src/swarm/profiler/` submodules (`1c43b99`)
- [x] Deconstruct `src/swarm/scheduler.ts` into `src/swarm/scheduler/` submodules (`490fe3c`)
- [x] Deconstruct `src/swarm/communication.ts` into `src/swarm/communication/` submodules (`43db2ff`)
- [x] Deconstruct `src/swarm/compression.ts` into `src/swarm/compression/` submodules (`8fca585`)
- [x] Deconstruct `src/swarm/speculative.ts` into `src/swarm/speculative/` submodules (`bbd68ce`)
- [x] Deconstruct `src/swarm/memory/cortex.ts` into `src/swarm/memory/` pipeline submodules (`73bb758`)
- [x] Deconstruct `src/swarm/cache.ts` and `src/swarm/health.ts` into dedicated directories (`272890d`)
- [x] Deconstruct `src/swarm/tools/builtin.ts` into dedicated domain tool modules (`f1f9ea4`)
- [x] Deconstruct `src/swarm/server.ts` into modular routes and utilities (`c29a83a`)
- [x] Deconstruct `src/swarm/parser.ts` and `src/swarm/coordination.ts` (`b2bdbca`)
- [x] Deconstruct `src/swarm/hierarchy.ts` into taxonomy, router, and tree modules (`4544387`)
- [x] Deconstruct `src/swarm/engine/clusterPipeline.ts` into topology, execution, and early exit (`b0aa1f9`)

## Phase 2: React Frontend & Optimization Runner Modularization
- [x] Extract `useSwarmSettings` and `useSwarmExecution` hooks from `src/App.tsx` (`5f5ca2a`)
- [x] Modularize `OptimizationRunner.tsx` into `useOptimizationRunner`, `optimizationGrading`, and `types` (`b661404`)
- [x] Add `test:unit` script to `package.json` and wire into unified `test` pipeline (`2afbe9c`)

## Phase 3: Comprehensive Verification
- [x] Verify Vitest test suite: 545/545 passed across 48 files
- [x] Verify TypeScript type safety: 0 errors
- [x] Verify Vite client production build
- [x] Verify Swarm library dual ESM/CJS build and TypeScript declarations
- [x] Verify zero breaking changes across all package exports and CLI commands
