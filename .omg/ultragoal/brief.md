# Ultragoal Brief: Implement S0–S11 from todo.md (Base 7576cb2c, main)

- **Objective:** Implement S0–S11 from `todo.md` on `main` (base `7576cb2c`), one commit per step, then run full `VERIFY` (`runNov20d.repro.test.ts`, `runNov20c.repro.test.ts`, `npm test`, `npx tsc --noEmit`, `node scripts/smoke-start.mjs`) and push `origin main`.
- **Base Commit:** `7576cb2c` (`main`)
- **Constraints:**
  - Node 22 strip-only TS (no parameter properties, enums, namespaces, `import=require`, decorators).
  - Keep budgets (groq 5600, slate 2000).
  - No DB/KV writes, flags, crons, or live calls.
  - With 0 picks: no critic pulls, no veto.
  - Explicit `git add <files>` (never `-A`); no reset/restore/clean/rebase/squash/force-push.
  - Note: `todo.md` has local uncommitted edits (`M todo.md`), and `/workspace/sw_n20e/src/__repro__/` is not present on this Windows host, so S0 authors `src/__repro__/runNov20d.repro.test.ts` (A–F).
