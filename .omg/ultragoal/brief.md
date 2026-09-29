# Ultragoal Brief: Perfect Swarm Optimization Implementation (2026-09-29)

## Objective
Route through and implement the remaining optimizations documented in `todo.md` (2026-09-29 edition):

1. **Goal 1 (Tier 1 Core):** Consensus / Majority Voting (#1). In `OptimizationRunner.tsx`, run analyst models 3×, calculate average/majority scores, gated behind a consensus toggle defaulting to true.
2. **Goal 2 (Tier 1 Resilience):** 429 Exponential Backoff + Retry-After (#2) & Circuit-Breaker Failover (#3). Parse `Retry-After` header or back off exponentially (2s → 4s → 8s up to 30s) per provider; skip models whose circuit is OPEN in failover loops.
3. **Goal 3 (Tier 1 Efficiency):** Output Token Caps (#4) & Persisted Grader Cache (#5). Enforce per-role max token caps (analyst ~1500, manager ~2000, grader 60, prompt-gen 300); persist grader cache to `localStorage` with 24h TTL.
4. **Goal 4 (Tier 2 Telemetry & Cost):** Cost Dashboard (#6) & Reward System Cleanup/Wiring (#7). Surface `totalTokensBurned`, `estimatedCostUsd`, and `errorRate` in diagnostics; wire or streamline reward telemetry.
5. **Goal 5 (Tier 2 Robustness & Throughput):** 404 Model Quarantine (#8), Prompt-Gen Caching (#10), and Concurrent Optimizer (#9). Quarantine models at 3 consecutive 404s; cache test prompts in memory/localStorage; test models concurrently with adaptive delay.
6. **Goal 6 (Tier 3 UX & Hardening):** Actionable Errors (#11), Grader Retry (#12), Prompt Truncation (#13), Prompt Hardening (#14), and LastError Truncation (#15). Map 401/429/5xx and strip stack traces; single-model grader retry; truncate stream event prompts to 800 chars; delimit user tasks with `<user_task>`; truncate `lastError` to 500 chars.
7. **Goal 7 (Tier 3 Polish):** Drop Empty KG Block (#16), Model Router Decision Chip (#17), Combo-History Reuse (#18), and One-Click Full Winning Config (#19). Omit zero KG block; display router decision chip; reuse combo scores within 7 days; add one-click winning config applicator.
8. **Goal 8 (Verification):** Full test suite, TypeScript type checking, and production build verification.

## Constraints & System Boundaries
- Zero conversational filler and fail-closed ledger checkpointing.
- Preserve backward compatibility with existing server and client contracts.
- Ensure all automated unit tests, server tests, and build scripts pass without regressions.
