# Ultragoal Brief — `fix/swarm-cortex-learning-loop`

## Objective
Implement `S1`, `S2`, and `S3` from `todo.md` on local feature branch `fix/swarm-cortex-learning-loop`:
- **S1:** Migrate embeddings from dead `text-embedding-004`/`text-embedding-005` to `gemini-embedding-2` (`outputDimensionality: 768`, no `taskType` on `gemini-embedding-2`, fallback to `gemini-embedding-001` only on 404/503), default collection `pwa_swarm_dev_cortex_v4` (remapping `v2`/`v3`), tag payloads with `embedModel`.
- **S2:** Match active `domains[]` on multi-sport slates with strict `appId` isolation, prioritize CLV + outcome contrastive pairs (`<= 3` wins, `<= 3` losses, deduplicated by `lessonId`/`eventId`), and expose idempotent `POST /api/cortex/ingest` & `POST /api/swarm/cortex/ingest`.
- **S3:** Emit truthful `cortexSummary` telemetry (`collectionName`, `embedModel`, `collectionPointCount`, `appliedDomains`, `scoreThreshold`, `topRawScore`, `embedError`, `qdrantError`, `status: 'Error' | 'Empty' | 'Success'`).

## Constraints & Architecture Boundaries
- Repo scope: `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits, zero SQL migrations.
- Local-only: Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do NOT run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
- Node 22 strip-only TypeScript compatibility (`import type`, no enums/parameter properties/decorators).
