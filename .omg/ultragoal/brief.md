# Ultragoal Brief — `wf-1795624413788`

## Objective
Implement `S1` from `todo.md` on local feature branch `fix/swarm-wf-1795624413788`:
- **S1:** Scope `row_side_mismatch` validation strictly to the pick's side label (prefer structured `pick.side`, strip rationale text after `—` / `–` / `-` / `:` / `because` / `over` / `vs` / `against`, and prevent opponent mentions in rationale from overriding the picked team).

## Constraints & Architecture Boundaries
- Repo scope: `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits, zero SQL migrations.
- Local-only: Local edits, `npx tsc --noEmit`, and `npx vitest run` ONLY. Do NOT run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
- Node 22 strip-only TypeScript compatibility (`import type`, no enums/parameter properties/decorators).
