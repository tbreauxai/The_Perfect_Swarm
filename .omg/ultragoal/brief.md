# Ultragoal Brief — `fix/swarm-wf-1795730839067`

## Core Objective
Implement `S1`, `S2`, and `S3` from `todo.md` (`wf-1795730839067`: Grounding Record-Split Matching, Negation-Aware Injury Disclaimer Guard & Verifier Seat ID Separation) on branch `fix/swarm-wf-1795730839067`.

## Constraints
- Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY.
- Zero `git push`, zero merge to `main`, zero deploy/remote commands, zero cross-repo edits, zero SQL migrations.
- Grep the entire repo for every other grounding regex (`Ungrounded record`, `symmetric_injury_misread`, `contra_steam_misread`, `model_signal_misread`) and failover-synthesis caller to verify negation/disclaimer phrasing and verifier seat IDs are handled consistently across all checks.
