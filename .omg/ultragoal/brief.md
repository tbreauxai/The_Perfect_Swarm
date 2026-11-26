# Ultragoal Brief — `wf-1795652004895`

## Objective
Implement `S1`, `S2`, and `S3` from `todo.md` on local feature branch `fix/swarm-wf-1795652004895`:
- **S1:** Isolate `symmetric_injury_misread`, `model_signal_misread`, and `contra_steam_misread` strictly to each pick's own claims and leg-targeted seat sentences; ignore generic 3-pillar framework overview sentences.
- **S2:** Wire `gemini-4-hydrogen` / `gemini-3.8-flash` / `gemini-3.6-flash` thinking hygiene (`thinkingLevel: "low"`, map `"minimal"` -> `"low"` on `gemini-4-*`, strip `thinking_budget` & `temperature`/`topP`/`topK` on `gemini-3.6+` and `gemini-4-*`, `thinkingLevel: "medium"` on `a1` failover to `gemini-3.5-flash-lite`), `15,000ms` Gemini proposer timeout + `a1` sibling order (`gemini-4-hydrogen -> gemini-3.8-flash -> gemini-3.5-flash-lite`), and instant `0ms` per-model skip on `429` `free_tier` + `limit: 0`.
- **S3:** Never downgrade `0`-row `OUT` players to `0.5 depth` based solely on team logged game count (`>= 5` distinct `game_date`s).

## Constraints & Architecture Boundaries
- Repo scope: `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits, zero SQL migrations.
- Local-only: Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do NOT run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
- Node 22 strip-only TypeScript compatibility (`import type`, no enums/parameter properties/decorators).
