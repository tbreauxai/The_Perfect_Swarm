# Ultragoal Brief: Real Analyst Role Attribution in Analyst Ledger (2026-09-30)

## Objective
Fix per-analyst learning attribution across the feedback loop by replacing hardcoded pipeline node names (`SpecialistRouter`, `Manager Node`, `Verification Node`) with real specialist analyst roles (`Quant Specialist`, `Market & Steam Specialist`, etc.) in `AnalysisOutcomeRecord`, `executeSwarmWorkflow`, and the `/api/swarm/feedback` handler.

## Source & Scope
- **Source:** `todo.md` ("Analyst Ledger Records Fake Roles") following commit `1b3bb72`.
- **Target Subsystems:** `src/swarm/feedback.ts`, `src/swarm/engine/index.ts`, `src/swarm/server.ts`, and test verification suites.
- **Constraints:** Backend only, zero external runtime dependencies added, full backward compatibility, safe fallback when `agentRoles` is empty.

## Micro-Goal Breakdown
1. **goal-1-feedback-record-agent-roles**:
   - Update `AnalysisOutcomeRecord` in `src/swarm/feedback.ts` to include `agentRoles?: string[]`.
   - Update `processFeedback` parameters to accept `agentRoles?: string[]` and store `agentRoles: params.agentRoles || []` on the outcome record.

2. **goal-2-engine-populate-analyst-roles**:
   - Update `executeSwarmWorkflow` in `src/swarm/engine/index.ts` to extract real analyst roles from `analysts` and `settings?.agents` and pass them into `processFeedback`.

3. **goal-3-server-analyst-ledger-real-roles**:
   - Update `POST /api/swarm/feedback` in `src/swarm/server.ts` to extract `agentRoles` from `workflowRecord` and record outcomes in `analystLedger` for real analysts instead of fake pipeline nodes.

4. **goal-4-test-verification-and-todo-update**:
   - Add unit/integration tests verifying real analyst role attribution in `analystLedger`.
   - Run vitest test suites, `test-sse-server.mjs`, `tsc --noEmit` linting, dual builds (`build:client` and `build:swarm`), and update `todo.md`.
