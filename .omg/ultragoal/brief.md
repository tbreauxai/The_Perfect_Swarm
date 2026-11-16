# Ultragoal Brief: fix/prefetch-args-evidence

- **Objective:** Prefetch `market_movement` with `market_type`; don't prefetch `get_player_prop_splits` without real `player_id` + `stat_category`; share a short injury summary with betting seats; strip approximate odds/percents/payouts from analysis text.
- **Base Commit:** `ab9237bd` (Swarm `main` after #158)
- **Branch:** `fix/prefetch-args-evidence`
- **Constraints:**
  - Prep only: no deploy, no prod SQL/db push, no live LLM or provider calls, no secrets in code/logs, no migration.
  - Node 22 strip-only TS (no param properties, enums, namespaces, import=require, decorators).
  - Do not raise `promptBudget` caps (Groq maxToolCalls 6 / maxToolResultChars 2000 / maxPromptChars 5600; others 8 / 6000 / 14000).
  - Missing != 0; never invent player ids, market types, odds, or percents.
  - `git add <explicit files>` only (never `-A`). Never reset / checkout . / restore / clean / rebase / squash / force-push. Commit after each step.
  - NEVER push to `main`; push only `fix/prefetch-args-evidence`. Do not merge Swarm between 9 and 10 PM CT.
