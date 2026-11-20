# Ultragoal Brief: Implement Changes from todo.md (fix/run-nov20)

- **Objective:** Implement S0–S6 from `todo.md` on branch `fix/run-nov20` from base `c3bf8541`, run full verification (`tsc --noEmit`, `vitest run`, `smoke-start.mjs`), and prepare/create the PR.
- **Base Commit:** `c3bf8541` (`main`)
- **Branch:** `fix/run-nov20`
- **Constraints:**
  - Prep only: no DB/KV writes, migrations, deploys, flag flips, forced crons, live analyze/chat calls, or paid provider probes. Never print keys.
  - Git discipline: commit after each passing step with explicit `git add <files>` (never `-A`). Edit only the files listed. Never reset/checkout `./restore/clean/rebase/squash/force-push`. Never push to `main`.
  - Node 22 strip-only TS (no parameter properties, enums, namespaces, `import=require`, decorators).
  - Do NOT change `seatBudget` caps (groq 5600 chars / 6 calls / 2000 result chars).
  - Note: `todo.md` has local uncommitted edits (`M todo.md`), and `/workspace/sw_n20/src/__repro__/` is not present on this Windows host, so S0 must either locate or author `src/__repro__/runNov20.repro.test.ts` (or clarify if `todo.md` dirty state should be handled before branching).
