# Consolidated Engineering Fix Spec — `The_Perfect_Swarm`

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits and zero SQL migrations.
**Combines:** `wf-1795448851648` fixes (Manager prompt bloat, failover cascade, Groq `Infinityms`, `partial: true` fallback shape, per-side pillar scoring) + Nov 2026 Gemini free-tier catalog & zero-quota health checks.

---

## Execution Rules & Token-Saving Guardrails
1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `fix/swarm-manager-gemini-consolidated`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Scope Manager Synthesis Context to Proposed/Approved Games (`27k chars` -> `<= 9k chars`)

### Observed Failure (`wf-1795448851648`, `idx 71`)
- The Risk Critic needed only `4,015 chars` covering the 3 proposed games, yet the Manager Node was fed `27,317 prompt chars` (`7,999` evidence chars) across all 17 games—causing Groq's token bucket, NVIDIA's 25s timeout, and Cloudflare's context limit to all fail during failover.

### Search Anchors
- `"Manager Synthesis Context"`, `"Manager Node"`, `"GodView Compiler"`, `"coveredEventIds"`, `"toolEvidence"`

### Required Changes
1. **Proposed-Game Scoping on Manager Context:**
   - When `a1`/`a2` proposed `>= 1` pick, build the Manager's `COMPACT SLATE` excerpt and `toolEvidence` strictly from the deduplicated `eventId`s of the proposed/approved picks (mirroring Groq Risk Critic scoping) rather than injecting the full 17-game slate.
   - Include the full compact slate ONLY when `0` picks were proposed (pass-only review).
2. **Enforce a Hard Manager Prompt Budget (`<= 9,000 chars` / `~2,400 tokens`):**
   - Strip redundant `toolEvidenceItems` duplicates and duplicate analyst prose before building the Manager prompt so every failover provider (Gemini, Groq, Mistral, Cloudflare) fits comfortably.

### Acceptance Criteria
- Unit test (17-game slate, 3 proposed games): Manager prompt includes ONLY those 3 games' slate rows and dossiers, and total prompt length is `<= 9,000 chars`.

---

## S2: Update Gemini Free-Tier Catalog (Nov 2026) & Fix Manager Failover Chain / Groq `Infinityms`

### Observed Failures (`wf-1795448851648`, `idx 75–84` + Unhealthy Free List)
1. Retired `gemini-2.0-*` / `gemini-2.5-*` and paid-only `gemini-4-argon`/`4-carbon`/`4-neon`/`3.1-pro-preview` IDs are breaking free-tier model selection.
2. `Gemini 503 high demand` on `gemini-3.1-flash-lite` immediately abandoned Gemini with zero retry and no free sibling fallback.
3. Groq `openai/gpt-oss-120b` skipped with `"token budget needs Infinityms"` (divide-by-zero or `requestedTokens > bucketCapacity`).
4. Failover routed Manager JSON compilation into slow `NVIDIA` 550B reasoning (25s timeout) and oversized `Cloudflare` (no output).

### Search Anchors
- `"gemini-3.1-flash-lite"`, `"gemini-2.5"`, `"gemini-2.0"`, `"token budget needs"`, `"Infinity"`, `"Failover"`, `"503"`, `"generativelanguage.googleapis.com"`

### Required Changes
1. **Update Free-Tier Gemini Registry (Nov 2026):**
   - **Keep ONLY active free-tier text/JSON models in the free list:**
     1. `gemini-3.5-flash-lite` (recommended primary Manager — fast, high free-tier RPD)
     2. `gemini-3.1-flash-lite` (high-RPD sibling fallback)
     3. `gemini-3.8-flash` (stronger Flash fallback when Flash-Lite hits `503`)
     4. `gemini-3.6-flash` (optional legacy Flash fallback; retiring `2027-01-28`)
     5. `gemma-4-31b-it` / `gemma-4-26b-a4b-it` (optional free-tier open weights)
   - **Remove from free list:** retired `gemini-2.0-flash`, `gemini-2.0-flash-lite`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, and paid-only (`quota 0` on free keys) `gemini-4-argon`, `gemini-4-carbon`, `gemini-4-neon`, `gemini-3.1-pro-preview`.
   - Transparently remap any persisted/retired `gemini-2.5-*` or `gemini-2.0-*` setting override to `gemini-3.5-flash-lite`.
   - Filter any dynamic `GET /v1beta/models` discovery strictly to `generateContent` text models, excluding `-image`, `-tts`, `-live`, `veo`, `imagen`, `omni`, `transcribe`, `embedding`, and paid-only Gemini 4 / Pro IDs in free-tier mode.
2. **Gemini Transient `503` Retry + Sibling Failover:**
   - On HTTP `503` / `500` / `overloaded` from the primary Gemini Manager model, perform **1 fast jittered retry (`1200–2000ms`)**, then fail over across free Gemini siblings (`gemini-3.5-flash-lite` -> `gemini-3.1-flash-lite` -> `gemini-3.8-flash`) BEFORE leaving Gemini.
3. **Fix Groq `"token budget needs Infinityms"` Math Bug:**
   - Guard against `tokensPerMs <= 0` and `requestedTokens > bucketCapacity` in the rate-limiter wait calculator—never compute or log `Infinityms`. If a prompt still exceeds a failover provider's limit, compact it or skip cleanly with `"prompt_exceeds_provider_limit"`.
4. **Fast Manager Failover Order:**
   - Order Manager failover as `Gemini primary -> Gemini sibling(s) -> Groq -> Mistral -> Cloudflare -> NVIDIA` so slow 550B reasoning models are last resort for JSON compilation.

### Acceptance Criteria
- Unit test (catalog): Free list includes `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3.8-flash`; excludes `gemini-2.0-*`, `gemini-2.5-*`, `gemini-4-argon`/`carbon`/`neon`, `gemini-3.1-pro-preview`; auto-remaps `gemini-2.5-flash` -> `gemini-3.5-flash-lite`.
- Unit test (Groq bucket): `requestedTokens > bucketCapacity` or `refillRate === 0` NEVER returns `Infinity` or `"Infinityms"`.
- Unit test (Gemini `503`): Mock `503` once -> retries and succeeds; mock `503` twice -> fails over to `gemini-3.1-flash-lite` -> `gemini-3.8-flash` before external providers.

---

## S3: Replace Quota-Burning Health Probes With Zero-Quota `GET /v1beta/models`

### Root Cause
- Gemini free-tier RPM/TPM/RPD quotas are enforced **per project**, and failed requests count against quota. Looping `generateContent` health probes across multiple Gemini models triggers project-wide `429 RESOURCE_EXHAUSTED` and flips the entire Gemini list `unhealthy`.

### Search Anchors
- `"unhealthy"`, `"health"`, `"probe"`, `"generateContent"`, `"429"`, `"RESOURCE_EXHAUSTED"`

### Required Changes
1. **Single Metadata Call for Gemini Health Checks:**
   - Replace per-model `generateContent` health-check loops for Gemini with ONE `GET https://generativelanguage.googleapis.com/v1beta/models` call (`0` generation quota, verifies API key validity and live model availability), cached for `15–30 minutes` in memory.
2. **Per-Model Runtime Cooldowns (Not Project-Wide Permanent Unhealthy):**
   - On runtime `503` or RPM `429`, apply a short per-model cooldown (`60s`; longer only if error explicitly states daily RPD exhaustion) without marking unrelated Gemini sibling models unhealthy.

### Acceptance Criteria
- Unit test: Checking 5 Gemini free-tier models issues **1** `GET /v1beta/models` call and **0** `generateContent` calls.
- Unit test: A runtime `503` on `gemini-3.5-flash-lite` cools down only that model, leaving `gemini-3.1-flash-lite` healthy.

---

## S4: Fix `partial: true` (`manager` Degraded) Fallback Payload

### Observed Failure (`wf-1795448851648`)
- When all Manager providers failed after Risk Critic returned `pass: true`, the partial fallback omitted top-level `picks`, `verified`, and `criticApproved`, and duplicated `a1`'s entire `1,200`-char scratchpad twice in `summary` (`"...\n\nKey points: ..."`), including the self-vetoed `R43` Thunder paragraph.

### Search Anchors
- `"Partial Analysis (from"`, `"sourceAnalyst"`, `"analystReport"`, `"degraded"`, `"Key points:"`

### Required Changes
1. **Deterministic Compilation Fallback When Critic Approved:**
   - If the Manager fails across all providers AFTER the Risk Critic completed with `pass: true` (or approved specific unvetoed picks):
     - Hoist the Critic-approved `picks` directly to top-level `picks: [...]` (strictly excluding any vetoed leg).
     - Set explicit top-level `criticApproved: true`, `wageringPass: false`, `verified: false`, `partial: true`, `degraded: ["manager"]`, and preserve `scorecards[]`.
     - Generate a concise, non-duplicated `summary` and `analysis` describing **only** those top-level `picks` (NO duplicated `"Key points:"` scratchpad dump and ZERO mention of rejected/evaluated non-picked `R#` rows).
   - If the Risk Critic did NOT run or returned `pass: false` when the Manager fails, fail closed: `picks: []`, `criticApproved: false`, `wageringPass: true`, `verified: false`.

### Acceptance Criteria
- Unit test (`manager` fails after Critic `pass: true` on `[R62, R12]`): Top-level `picks.length === 2` (`R62`, `R12`), `criticApproved === true`, `verified === false`, `partial === true`, non-duplicated `summary` with zero mention of `R43`, `scorecards` intact.
- Unit test (`manager` fails with no Critic approval): Fails closed with `picks: []`, `criticApproved: false`, `wageringPass: true`, `verified: false`.

---

## S5: Score `=== TOP PILLAR CANDIDATES ===` Per Side (Fix Split-Direction `"3 pillars"` Bug)

### Observed Failure (`wf-1795448851648`)
- `nba-401910038` was ranked `[3 pillars: form=OKC, steam=TOWARD home Indiana Pacers, health=home_advantage]`, summing opposing sides (OKC form + Indiana steam + Indiana health) into a fake `"3 pillars"` score.

### Search Anchors
- `"=== TOP PILLAR CANDIDATES"`, `"pillars:"`, `"home_advantage"`, `"away_advantage"`

### Required Changes
- Compute pillar counts independently for `home` and `away`, and rank/display ONLY the winning side's aligned pillar count (e.g., `[2 pillars (home IND): steam=TOWARD home Indiana Pacers, health=home_advantage]`).
- Do NOT count `Total TOWARD Over/Under` as a side-spread pillar (note total steam separately as `total_steam`).

### Acceptance Criteria
- Unit test (`nba-401910038`: `form=OKC`, `steam=TOWARD home IND`, `health=home_advantage IND`): Scored as `2 pillars` for `home (IND)`, NOT `3 pillars`.
- Unit test (`nba-401910044`: `form=LAL`, `health=home_advantage LAL`, `steam=TOWARD Under`): Side pillar count for `LAL` is `2` (`form`, `health`), with total steam noted separately.

---

## Verification Commands
```powershell
npx tsc --noEmit
npx vitest run
```