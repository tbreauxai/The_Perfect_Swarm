# Ultragoal Brief — Live Free-Tier Model Discovery (`feat/swarm-live-models`)

## Objective
Implement `S1` from `todo.md` on local feature branch `feat/swarm-live-models`:
- Expose authenticated `GET /api/swarm/models/live` and `GET /api/models/live` endpoints using Render `process.env` provider keys with a `6h` in-memory cache, `?refresh=true`, and optional `?probe=true`.
- Support `gemini`, `nvidia` (with `models.dev` fallback), `groq`, `mistral`, `openrouter` (strictly `prompt=0 && completion=0` or `:free`), and `cloudflare`, never leaking API keys in responses or error strings.

## Constraints & Architecture Boundaries
- Repo scope: `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits, zero SQL migrations.
- Local-only: Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do NOT run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
- Node 22 strip-only TypeScript compatibility (`import type`, no enums/parameter properties/decorators).
