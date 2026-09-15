# Implementation Plan: Full Codebase Error Audit & Remediation

- [x] Task: Phase 1 - Test Suite Audit & Failure Remediation [805dfbc]
    - [x] Write failing test or isolate assertion failure in `test-portable-swarm.ts` for Gemini complex model routing [805dfbc]
    - [x] Implement fix in `src/swarm/router.ts` / defaults to align model tier routing with expectations [805dfbc]
    - [x] Run and verify all 5 test suites (`test:portable`, `test:simulation`, `test:dist`, `test:cli`, `test:server`) pass cleanly [805dfbc]
    - [x] Task: Phase Verification & Checkpoint (Refer to workflow.md) [805dfbc]

- [x] Task: Phase 2 - Type Checking, Build & Packaging Audit [verified]
    - [x] Execute `tsc --noEmit` across whole repo and fix any uncovered type inconsistencies [verified]
    - [x] Audit and run `npm run build:client` (Vite, React 19, Tailwind v4) [verified]
    - [x] Audit and run `npm run build:swarm` (dual ESM/CJS, `.d.ts` declaration generation) [verified]
    - [x] Verify `package.json` entry points and CLI execution (`node bin/cli.js --help`) [verified]
    - [x] Task: Phase Verification & Checkpoint (Refer to workflow.md) [verified]

- [x] Task: Phase 3 - Core Swarm Engine & Runtime Resilience Audit [6fedfde]
    - [x] Audit `src/swarm/engine.ts`, `lifecycle.ts`, and `hierarchy.ts` for unhandled rejections and hang states [6fedfde]
    - [x] Audit `src/swarm/router.ts` and `loadBalancer.ts` for provider rate limit (429) failover logic [6fedfde]
    - [x] Audit `src/swarm/memory.ts` and `cache.ts` for graceful Qdrant disconnection fallback [6fedfde]
    - [x] Task: Phase Verification & Checkpoint (Refer to workflow.md) [6fedfde]

- [ ] Task: Phase 4 - Frontend & Server API Resilience Audit
    - [ ] Audit `server.ts` endpoints and SSE stream handling under unexpected client disconnects
    - [ ] Audit frontend components and `providerService.ts` for unhandled promise rejections and state desync
    - [ ] Execute end-to-end verification and compile final audit summary
    - [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)
