# Ultragoal Brief — `feat/deterministic-verifier-and-failover-hygiene`

## Core Objective
Implement `S1`–`S4` from `todo.md` plus the hard same-`event_id` / distinct-game parlay leg cap constraint (`wf-1795734233660` & `/models/live` audit).

## Constraints
- Local edits, `npx tsc --noEmit`, targeted `npx vitest run` ONLY.
- Zero `git push`, zero merge to `main`, zero deploy/remote commands, zero cross-repo edits, zero SQL migrations.
- Final grep audit across the repo for remaining LLM verifier calls, timeout/retry loops, failover lists referencing `gemini-4-hydrogen`, and `/models/live` filters.
