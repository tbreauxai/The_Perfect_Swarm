# Ultragoal Brief: Outcomes-Driven Routing and Persisted Analyst Ledger (2026-09-30)

## Objective
Implement the two flagged improvements from `todo.md`:
1. **Outcomes Influence Routing**: Add an accuracy dimension to `SpecialistCapabilityProfiler` (`src/swarm/loadBalancer.ts`) so bet outcomes (win/loss/push) influence routing and failover priority without conflating execution success/failure.
2. **Persisted Analyst Ledger**: Add optional persistent backing (file-based in Node environments with debounce, plus import/export/load/save APIs) to `analystLedger` in `src/swarm/feedback.ts` so per-analyst win/loss history survives server restarts and redeploys.

## Target Subsystems
- `src/swarm/loadBalancer.ts` & `src/swarm/loadBalancer.test.ts`: Accuracy dimension, `recordAccuracy`, and `getCapabilityScore` weighting.
- `src/swarm/server.ts` & `src/swarm/server.test.ts`: Wire `/api/swarm/feedback` to both `analystLedger` and `globalSpecialistProfiler`.
- `src/swarm/feedback.ts` & `src/swarm/feedback.test.ts`: File-backed persistence for `analystLedger`.
- `todo.md`: Document resolution of flagged items.

## Micro-Goal Breakdown
1. **goal-1-profiler-accuracy-dimension**:
   - Add accuracy metrics (`accuracyWins`, `accuracyLosses`, `accuracyPushes`, `accuracyScore`) to `SpecialistCapabilityProfile`.
   - Add `recordAccuracy(agentRole, outcome)` and blend accuracy into `getCapabilityScore` / `getUcb1Score`.
   - Add unit tests verifying execution reliability vs bet accuracy scoring separation.

2. **goal-2-wire-server-feedback-to-profiler**:
   - Update `POST /api/swarm/feedback` in `src/swarm/server.ts` to call `globalSpecialistProfiler.recordAccuracy(role, outcome)`.
   - Ensure `GET /api/swarm/metrics` surfaces capability profiles with accuracy metrics.
   - Verify that routing prioritizes specialists with higher historical accuracy.

3. **goal-3-persist-analyst-ledger**:
   - Implement storage persistence on `analystLedger` in `src/swarm/feedback.ts` (`load()`, `save()`, `export()`, `import()`, `initPersistence()`).
   - Add automated debounced file persistence in Node/Render environments with fallback in Edge/browser.
   - Add unit tests verifying ledger hydration, saving, and persistence across simulated reboots.

4. **goal-4-test-verification-and-todo-update**:
   - Execute full test suite (`vitest`, `npm test`, `test-sse-server.mjs`, `tsc --noEmit`).
   - Build production ESM/CJS bundles (`npm run build:swarm`, `npm run build:client`).
   - Update `todo.md` marking flagged items fully implemented.
