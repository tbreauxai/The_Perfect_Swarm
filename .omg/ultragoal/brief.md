# Ultragoal Brief: fix/chat-empty-output

- **Objective:** Surface the critic's "no parlay + why" instead of an empty chat card; parse Llama function-call JSON; wrap bare pick arrays instead of placeholdering.
- **Base Commit:** `d814e50` (Swarm `main` after #156)
- **Branch:** `fix/chat-empty-output`
- **Constraints:**
  - Prep only: no deploy, no prod SQL/db push, no live LLM or provider calls, no secrets in code/logs, no migration.
  - Node 22 strip-only TS (no param properties, enums, namespaces, import=require, decorators).
  - Do not raise caps (Groq 1500 in `limiter.ts` is a red herring; leave it).
  - `git add <explicit files>` only (never `-A`). Never reset / checkout . / restore / clean / rebase / squash / force-push. Commit after each step.
  - NEVER push to `main`; push only `fix/chat-empty-output`. Do not merge Swarm between 9 and 10 PM CT.
