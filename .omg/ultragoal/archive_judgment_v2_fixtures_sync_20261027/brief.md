# Ultragoal Brief: Sync Judgment V2 Fixtures with DuelOdds b264058f

## Objective
Sync judgment v2 test fixtures with DuelOdds `b264058f` verbatim and adapt `src/swarm/server/judgmentV2.test.ts` to the new `input` layout while preserving runtime behavior.

## Constraints & Rules
- Base: `06f18604` (`main`)
- Branch: `test/judgment-v2-fixtures-sync`
- One commit per step:
  - Step 1: `chore: smoke step` (empty commit)
  - Step 2: `test(judgment): sync v2 fixtures with DuelOdds b264058f input layout`
- Never run: `git reset`, `git checkout .`, `git restore`, `git clean`, `git rebase`, or squash.
- Never use `git add -A`.
- Node 22 `--experimental-strip-types` compliance.
