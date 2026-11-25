# Ultragoal Brief — `wf-1795618886150`

## Objective
Implement `S1` and `S2` from `todo.md` on local feature branch `fix/swarm-wf-1795618886150`:
- **S1:** Always emit top-level boolean `criticApproved` on final payloads, tighten NHL `-1.5` puckline vs. ML `-220` to `+150` price-band guidance & audit, and preserve policy price-band expressions in `stripApproximateOdds`.
- **S2:** Cap full proposer dossiers (`<= 10` full sections + compact 1-line summaries) on `>= 12`-game slates for both `a1` and `a2`, support `espn_depthchart` starter rows in `get_injury_and_roster_delta`, and deduplicate `H2H:` lines by `(game_date, sorted_scores)`.

## Constraints & Architecture Boundaries
- Repo scope: `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits, zero SQL migrations.
- Local-only: Local edits, `npx tsc --noEmit`, and `npx vitest run` ONLY. No `git push`, merge to `main`, deploy scripts, or live service mutations.
- Node 22 strip-only TypeScript compatibility (`import type`, no enums/parameter properties/decorators).
