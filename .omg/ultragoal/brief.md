# Ultragoal Brief — runNov21d

## Objective
Implement `S0`–`S4` and `VERIFY` from `todo.md` on `main` (base `651a40ad`, run `wf-1795276340194`), one commit per step, then push `origin main`.

## Constraints & Architecture Boundaries
- Node 22 strip-only TS (no parameter properties, enums, namespaces, `import=require`, decorators).
- Do not change budgets (`groq` `5600`/`6 calls`, others `14000`/`8`) or the RPC.
- No DB/KV writes, flags, crons, live analyze/chat/morning calls, tokens, or debug routes.
- Git: explicit `git add <files>` (never `-A`); no reset/restore/clean/rebase/squash/force-push.
- Render deploy note: push = Render deploy; NO Swarm push between 9 and 10 PM CT.
- Note on `git status`: `todo.md` and `.omg/ultragoal/*` are local unstaged session files (never reset/checkout/clean them).
