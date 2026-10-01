# Ultragoal Brief: Phase 0B — Diagnose & Fix Reward Anomaly (2026-09-30)

## Objective
Implement the 4-part optimization and diagnostic fix from `todo.md` ("Phase 0B: Diagnose the 0.136 Reward Anomaly"):
1. **Full Observability (Stop Discarding Evidence)**:
   - Extend `Policy Tuned & Outcome Indexed` event in `src/swarm/engine/index.ts` to log both `rewardComponents` and `rewardInputs`.
   - Include `components` in `POST /api/swarm/feedback` response in `src/swarm/server.ts`.
2. **Rescale Dead Penalties**:
   - Rescale `durationMs` from 3,000ms saturation to 120,000ms (2 minutes) in `src/swarm/feedback.ts`.
   - Rescale `tokensConsumed` from 10,000 saturation to 100,000 in `src/swarm/feedback.ts`.
   - Eliminate constant -0.20 operational tax so good runs can reach ~0.80.
3. **Split Hard Errors from Graceful Failovers**:
   - Distinguish `hardErrorCount` vs `failoverCount` in workflow metrics and `calculateReward`.
   - Restrict accuracy degradation (`1 - hardErrorCount * 0.3`) strictly to unrecovered hard failures; treat recovered failovers with a minor separate penalty or zero demerit.
4. **Blend Analyst Accuracy & System Verification**:
   - Blend participating analysts' observed historical accuracy from `analystLedger` / `globalSpecialistProfiler` into per-run workflow accuracy.
   - Run full verification (`vitest`, `npm test`, `tsc --noEmit`, dual builds) and update `todo.md`.

## Micro-Goal Breakdown
1. **goal-1-observability-reward-inputs-and-components**:
   - Extend `Policy Tuned & Outcome Indexed` event in `src/swarm/engine/index.ts` with `rewardComponents` and `rewardInputs`.
   - Include `components` in `POST /api/swarm/feedback` response in `src/swarm/server.ts`.
2. **goal-2-rescale-dead-penalties-in-reward**:
   - Rescale duration and token consumption denominators in `src/swarm/feedback.ts` `calculateReward`.
   - Verify sensitivity across test workloads.
3. **goal-3-split-hard-errors-from-failovers**:
   - Track `failoverCount` and `hardErrorCount` across `SwarmMetricsCollector` and `WorkflowMetrics`.
   - Isolate accuracy term penalty to `hardErrorCount` so resilience failovers do not destroy accuracy.
4. **goal-4-blend-analyst-accuracy-and-system-verification**:
   - Anchor workflow accuracy to participating analysts' ledger win rates.
   - Run full Vitest, CLI, and SSE server suites, TypeScript lint, production bundle builds, and update `todo.md`.
