# Ultragoal Brief: Canonical Failover Seat Keys & Manager Chain Gemini 3.1 (S0–S2, Base 75ae6cfc)

- **Objective:** Implement S0–S2 from `todo.md` on `main` (base `75ae6cfc`), one commit per step, then run `VERIFY` and push `origin main`.
- **Base Commit:** `75ae6cfc` (`main`)
- **Constraints:**
  - Node 22 strip-only TS (no parameter properties, enums, namespaces, `import=require`, decorators).
  - Keep budgets (groq 5600, `proposerHeaderBudget`, frontrunner `maxToolCalls`).
  - No DB/KV writes, migrations, flags, crons, live calls, or token printing.
  - Explicit `git add <files>` (never `-A`); no reset/restore/clean/rebase/squash/force-push.
  - Note: `/workspace/sw_n20k_repro/runNov20j.repro.test.ts` is not present on this Windows host, so S0 authors `src/__repro__/runNov20j.repro.test.ts` (`T`, `U`).
