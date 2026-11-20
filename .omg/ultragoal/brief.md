# Ultragoal Brief: Persist RunDebugRecord to Supabase (S0–S3, Base ff2a06ab)

- **Objective:** Implement S0–S3 from `todo.md` on `main` (base `ff2a06ab`), one commit per step, then run `VERIFY` (`npx tsc --noEmit`, `npx vitest run`, `node scripts/smoke-start.mjs`) and push `origin main`.
- **Base Commit:** `ff2a06ab` (`main`)
- **Constraints:**
  - Node 22 strip-only TS (no parameter properties, enums, namespaces, `import=require`, decorators).
  - Budgets unchanged. No new deps. Free tier only. Never log or store keys.
  - PREP ONLY: do NOT apply the migration, run SQL against prod, or set any env var (Render or Supabase).
  - Explicit `git add <files>` (never `-A`); no reset/restore/clean/rebase/squash/force-push.
  - Note: `todo.md` has local uncommitted edits (`M todo.md`).
