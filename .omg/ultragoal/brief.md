# Ultragoal Brief: Full IDE Punchlist Implementation (The Perfect Swarm)

## Objective
Implement all phases of `ide_punchlist_perfect_swarm.txt` in `tbreauxai/The_Perfect_Swarm` systematically, one phase at a time:
1. Phase 1 — Step 0 shared error helper & app token UI
2. Phase 2 — Issues 1 + 4 together (run path in-flight guard, AbortController, connect/idle timeouts, SSE heartbeat)
3. Phase 3 — Issue 2 (diagnostics viewer error handling, calm app-auth state, polling pauses, env status resilience)
4. Phase 4 — Issue 5 (models spinner body timeout, agent configurator effect deps & fallback text input)
5. Phase 5 — Issue 3 (input size client limits & counters, server bodyLimit 2MB 413 guard, firewall 403 handling)
6. Phase 6 — Issue 6 (soft 200 prevention, robots.txt, static asset MIME handling, strict shell fallback 404s)
7. Phase 7 — Extras (CSP connect-src cleanup, production in-memory fallback warnings)
8. Swarm feedback CORS before auth (CORS middleware ahead of auth, inner auth bypass, feedback duplicate deduplication, tests)
9. Full Verification & Regression Gate

## Constraints & Boundaries
- **Order of Execution**: Top to bottom as specified in `ide_punchlist_perfect_swarm.txt`.
- **Phase 2 Bundling**: Issues 1 + 4 must ship together as one change on the run path.
- **CORS Priority**: Ship Swarm repo CORS before auth ahead of DuelOdds repo changes.
- **Preserve Archive Fixes**:
  - `fix_swarm_hang_analyzing_forever_20260914` (real-time timeline rendering, cancel button, 429 failover)
  - `fix_settings_agent_tab_crash_20260913` (defensive settings defaults, optional chaining, model health check safety)
- **Policy/Infra Blockers Explicitly Flagged**:
  - `/api/config/status` public skip list & execution pre-flight blocked pending Tyler decision.
  - Cloudflare edge custom domain / skip rule blocked pending Tyler decision (friendly 403 error handled in parseHttpError).
  - Persistent Qdrant provisioning on Render is an infra/env task, not code.
- **Test Integrity**: Maintain 100% test pass rate across Vitest, Portable Swarm, Multi-App Simulation, CLI, and SSE test suites.
