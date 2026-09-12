# Ultragoal Brief: Modular Portable AI Swarm & Qdrant Optimization

## Core Objective
Audit the codebase to identify architectural and setup optimization opportunities, then transform the AI swarm and Qdrant memory systems into a decoupled, highly efficient, and fully portable engine that can be easily transplanted into any future application for deep analysis.

## Constraints & Architecture Boundaries
- Portability: The swarm engine core must be entirely decoupled from web/framework bindings (Express, Vite, React) and exportable as a standalone module.
- Qdrant Vector Setup: Correct schema definitions (remove hallucinated/invalid properties like `turbo4` and `turbo` quantization), enforce valid Qdrant REST client configurations (standard scalar quantization, on-disk storage, sparse/dense hybrid search with RRF).
- AI Provider Extensibility: Refactor provider handling into a clean Provider Adapter pattern so new providers can be registered without modifying core classes.
- Deep Analysis Integration: Connect semantic memory (Qdrant `MemoryCortex`), adaptive routing (`ModelRouter`), and iterative red-team/critic verification (`AnalysisLifecycle`) into the orchestration pipeline.
- Non-Breaking: Ensure existing frontend UI (`src/App.tsx`) and HTTP endpoints continue to function without regressions.
- Verification: Clean TypeScript compilation (`tsc --noEmit`) and successful Vite build (`npm run build`).
