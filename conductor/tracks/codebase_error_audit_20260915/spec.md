# Specification: Full Codebase Error Audit & Remediation

## Overview
Perform a comprehensive end-to-end audit across the entire "The Perfect Swarm" repository. Identify, catalog, and fix all compile-time errors, test failures, runtime edge cases, unhandled rejections, packaging inconsistencies, and client-server communication bugs.

## Audit & Remediation Scope

### 1. Test Suite Integrity & Regression Fixes
- Execute all test suites defined in `package.json`:
  - `npm run test:portable` (`test-portable-swarm.ts`)
  - `npm run test:simulation` (`test-multi-app-simulation.ts`)
  - `npm run test:dist` (`test-dist-import.mjs` & `test-dist-import.cjs`)
  - `npm run test:cli` (`test-cli.mjs`)
  - `npm run test:server` (`test-sse-server.mjs`)
- Fix existing failure in `test-portable-swarm.ts:130` regarding default complex model routing for Gemini (`gemini-2.5-flash` vs `gemini-3.1-pro`).
- Ensure all tests pass deterministically without flaky timeouts or hanging processes.

### 2. Type Checking, Build & Packaging Integrity
- Validate `npm run lint` (`tsc --noEmit`) passes with zero warnings or errors.
- Validate `npm run build:client` (Vite 6, React 19, Tailwind v4).
- Validate `npm run build:swarm` (Dual ESM/CJS build, `.d.ts` rollup, CLI binary shebang and execution permissions).
- Verify all exports mapped in `package.json` (`./core`, `./memory`, `./router`, `./lifecycle`, `./cache`, `./hierarchy`, `./loadBalancer`, `./engine`, `./profiler`, `./server`, `./tools`, `./parser`, `./client`) resolve properly in both Node ESM and CJS environments.

### 3. Swarm Core Runtime & Resilience Audit
- Inspect `src/swarm/engine.ts`, `lifecycle.ts`, `router.ts`, `memory.ts`, `cache.ts`, `loadBalancer.ts`, and `tools/`:
  - Verify error handling and failover during upstream LLM provider rate limits (429), timeouts, and invalid API keys.
  - Verify Qdrant memory fallback when Qdrant is unreachable or times out (ensuring no infinite loops or unhandled rejections).
  - Verify stream cleanup and abort signal propagation to prevent dangling network requests.

### 4. Frontend & Express Server API Contract Audit
- Inspect `server.ts` routes, middleware, and SSE stream endpoints.
- Inspect frontend React components (`src/components/`, `src/services/providerService.ts`, `src/hooks/`) for uncaught errors, null-dereference hazards, and proper UI error boundary behavior.

## Acceptance Criteria
1. `npm test` runs all 5 test scripts cleanly with 100% pass rate.
2. `npm run lint` (`tsc --noEmit`) passes with 0 errors.
3. `npm run build` completes cleanly without warnings or export mismatches.
4. Any discovered runtime crashes or unhandled promise rejections are patched with corresponding regression tests.

## Out of Scope
- Adding new AI provider integrations beyond the existing 5 (Gemini, Groq, OpenRouter, Mistral, GitHub).
- Aesthetic UI redesigns or major cosmetic feature changes.
