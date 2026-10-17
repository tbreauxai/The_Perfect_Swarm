# Ultragoal Brief: R3-S1 Morning Run Dedupe Hotfix

## Objective
Implement R3-S1 hotfix for `The_Perfect_Swarm`:
- Delete the Render cron service and remove `scripts/morning-cron.mjs`.
- Add in-process single-flight locking and 20-minute per-game claim tracking for `/api/swarm/morning`.
- Update Supabase partition rule so that already judged games today (and awaiting_lines without new lines) are skipped.
- Add test coverage (`morningDedupe.test.ts`) and run smoke test (`scripts/smoke-start.mjs`).
- Produce 11 clean commits on branch `fix/morning-dedupe` and open a PR against `main`.

## Constraints & Rules
- Zero conversational filler.
- Exactly 11 commits named `step 1` through `step 11`.
- Never run `git reset`, `git checkout .`, `git restore`, `git clean`, `git rebase`, or squash.
- Never commit `todo.md`, `benchmark.md`, or `.omg/`.
- All linters, unit tests, simulation, build, and smoke tests must pass.
