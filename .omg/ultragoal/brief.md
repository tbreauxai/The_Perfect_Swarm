# Ultragoal Brief: fix/seat-evidence-verdicts

- **Objective:** Return seat tool evidence to the manager and verifier; mark failed verification `verified:false` and clear picks; critic emits a verdict only; prefetch Quant/Market role tools per slate game; slate names are authoritative.
- **Base Commit:** `a6e4099c` (Swarm `main` after #157)
- **Branch:** `fix/seat-evidence-verdicts`
- **Constraints:**
  - Prep only: no deploy, no prod SQL/db push, no live LLM or provider calls, no secrets in code/logs, no migration.
  - Node 22 strip-only TS (no param properties, enums, namespaces, import=require, decorators).
  - Do not raise `promptBudget` caps (Groq maxToolCalls 6 / maxToolResultChars 2000 / maxPromptChars 5600; others 8 / 6000 / 14000).
  - `git add <explicit files>` only (never `-A`). Never reset / checkout . / restore / clean / rebase / squash / force-push. Commit after each step.
  - NEVER push to `main`; push only `fix/seat-evidence-verdicts`. Do not merge Swarm between 9 and 10 PM CT.
