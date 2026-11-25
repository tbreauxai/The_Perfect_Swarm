# Ultragoal Brief — `wf-1795647813045` (`fix/swarm-final-polish`)

## Objective
Implement `S1` and `S2` from `todo.md` on local feature branch `fix/swarm-final-polish`:
- **S1:** Require `>= 2` logged games (or season baseline `games_played >= 5`) for boxscore `Tier-1` / `Tier-1 Q` promotion on non-QB/non-G players, close remaining unlogged -> `0.5 depth` leaks on `< 5`-date teams, and support `espn_roster_meta` / `nhl_roster_meta` rows (NFL OL `experience_years >= 4` or `depth_rank === 1` -> Tier-2 `1.5`, other `games_played === 0` -> neutral `1.0` `unlogged` or `0.5` if `experience_years === 0`).
- **S2:** Reconcile any `picks=<N>` token in `summary` / `analysis` strictly with `compiled.picks.length` inside `syncCompilerProseWithFinalPicks`.

## Constraints & Architecture Boundaries
- Repo scope: `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits, zero SQL migrations.
- Local-only: Local edits, `npx tsc --noEmit`, and `npx vitest run` ONLY. Do NOT run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
- Node 22 strip-only TypeScript compatibility (`import type`, no enums/parameter properties/decorators).
