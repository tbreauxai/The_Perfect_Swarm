# Ultragoal Brief: Implement Changes from todo.md

## Objective
Implement and verify all phases from `todo.md` (Phase 0B and Phase 1):
1. Phase 0B: Fix the 0.136 Reward Anomaly & Rescale Penalties
   - Stop discarding reward components and inputs in engine events and server responses.
   - Rescale latency penalty (durationMs/120000) and cost penalty (tokensConsumed/100000).
   - Split unrecovered hard errors from graceful provider failovers in accuracy calculations.
   - Blend empirical analyst ledger win rate into operational accuracy.
2. Phase 1: Reward Weight Calibration & Graded Outcome Correlation
   - Implement Pearson correlation coefficient ($r$) and MSE between normalized composite rewards and empirical outcomes.
   - Implement bounded stochastic optimization across convex weights summing to 1.0.
   - Implement knowledge repository outcome auto-harvesting for continuous calibration.
   - Expose `POST /api/swarm/calibrate` and `GET /api/swarm/calibrate` API endpoints.
3. Verification & Regression Gate:
   - Verify all test suites (Vitest, Portable Swarm, Multi-App Simulation, CLI, and SSE test suites) pass with 0 regressions.

## Constraints & Boundaries
- Maintain strict backward compatibility for `/api/swarm/feedback` and SSE streaming schemas.
- Ensure bounded optimization constraints for reward weights (quality: 0.10–0.60, accuracy: 0.15–0.65, latency: 0.02–0.35, cost: 0.01–0.20, savings: 0.02–0.25).
- Ensure failovers receive minor penalties (-0.02, max -0.06) without depressing base accuracy.
- Maintain 100% test pass rate across all suites.
