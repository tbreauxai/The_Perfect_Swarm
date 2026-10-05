# Ultragoal Brief: Fix 4 - One Shared Cortex, Tags & Blended Retrieval Policy

## Objective
Implement one shared cortex (`pwa_swarm_dev_cortex_v2`) with tagging (`originApp`, `domain`, `memoryType`, `entityIds`) and a blended cross-app retrieval policy. Sibling applications may read matching memories based on domain and shared entities, while writes, deletes, and consolidation remain strictly namespaced.

## Constraints & Architectural Boundaries
- Do NOT create a second Qdrant collection; keep default `pwa_swarm_dev_cortex_v2`.
- Do NOT change caller auth (`createAppAuthMiddleware`, `SWARM_APP_TOKENS`).
- Do NOT change CORS or provider-key handling.
- Do NOT migrate old points; treat missing tags as `originApp=payload.appId, domain=general, memoryType=judgment, entityIds=[]`.
- Keep existing `appId` equal to `originApp` on write so existing filters do not break.
- Body appId cannot change `originApp` on write.
- Keep operational commentary under 10 words; zero conversational filler.

## Key Architecture Decisions
1. **Tag Every New Point**:
   - `originApp`: Authenticated caller (`callerAppId`), otherwise server default app id. Never client body.
   - `appId`: Always equal to `originApp`.
   - `domain`: `odds` | `injury` | `lineup` | `fantasy` | `general` (default: `general`).
   - `memoryType`: `fact` (graded outcomes, verified observations) | `judgment` (model picks, ungraded notes).
   - `entityIds`: String array of team, player, or game IDs. Empty array allowed.
2. **Blended Retrieval Policy**:
   - Same `originApp` + same `domain`: weight 1.0.
   - Different `originApp` + same `domain` + >= 1 shared `entityId`: weight 0.45.
   - Everything else: weight 0 (excluded).
   - A `fact` outranks a `judgment` at the same weight. Apply weight after vector score, before limit.
   - `includeShared === false`: override to same `originApp` only.
   - Client body can request a read domain.
3. **Namespaced Deletes & Consolidation**:
   - `wipe` and `consolidateMemories` filter on `originApp`.
   - Wiping one app (e.g. `duelodds`) does not touch sibling app data (e.g. `fantasy`).
