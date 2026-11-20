# Ultragoal Brief: Fix wf-1795200330594 Empty-Picks Verification Failure & Stage 2 Critic Re-prompt

- **Objective:** Fix the two regressions observed in `todo.md` (`wf-1795200330594`):
  1. Deep Analysis Verification Loop (`src/swarm/lifecycle.ts`) fails with RLAIF 35% when the Manager legitimately returns `picks: []` (NO-BET / PASS), because the Verification Critic rejects empty `picks`.
  2. Stage 2 Risk Critic re-prompt (`src/swarm/engine/analystExecution.ts`) triggers a malformed tool-call JSON (`{"path":"","query":"...","max_results":20}`) and `contract_violation` instead of a verdict JSON.
- **Constraints:**
  - Node 22 strip-only TS.
  - Preserve `seatBudget` caps and existing `__repro__` tests.
