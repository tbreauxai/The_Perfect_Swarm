# Engineering Spec — `The_Perfect_Swarm` (Fix Dead `text-embedding-004` Cortex, Multi-Sport `domains[]` Retrieval & Truthful Flight Recorder Telemetry)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero edits to `DuelOdds` and zero SQL migrations.
**Confirmed Failures:**

1. `qdrantEmbeddingModel: "text-embedding-004"` was shut down on the Gemini API (`Jan 14, 2026`, HTTP `404`), causing every Qdrant embed/query/upsert to silently fail while reporting `cortexSummary.status: "Success"`.
2. Multi-sport parlay requests send `domain: "multi-sport"` + `domains: ["nfl", "nba", "nhl"]`, so single-domain Qdrant filters miss sport-specific memories.
3. `cortexSummary` hides collection point count, embedding model/error, applied filter, and top score.

---

## Execution Rules & Token-Saving Guardrails

1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `fix/swarm-cortex-learning-loop`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Migrate Embeddings From Dead `text-embedding-004` to `gemini-embedding-2` (`outputDimensionality: 768`)

### Search Anchors

- `"text-embedding-004"`, `"embedContent"`, `"qdrantEmbeddingModel"`, `"HybridCortex"`, `"pwa_swarm_dev_cortex"`

### Required Changes

1. **Replace `text-embedding-004` Everywhere (Including Incoming Overrides):**
   - Change the default embedding model to `"gemini-embedding-2"` (and intercept/remap any legacy incoming `settings.qdrantEmbeddingModel === "text-embedding-004"` or `"embedding-001"` to `"gemini-embedding-2"` so stale browser `localStorage` configs cannot re-break it).
   - Default collection name to `"pwa_swarm_dev_cortex_v4"` (768 dims, Cosine) when incoming `qdrantCollectionName` is empty or legacy `"pwa_swarm_dev_cortex_v3"`, OR auto-create the collection at `768` dims if absent.
2. **`gemini-embedding-2` Request Hygiene:**
   - Pass `outputDimensionality: 768` on every `embedContent` request.
   - Omit `taskType` / `task_type` whenever the model is `gemini-embedding-2` (unsupported on Embedding 2; only pass `taskType` if `gemini-embedding-001`).
   - Support automatic fallback to `gemini-embedding-001` (`outputDimensionality: 768`) ONLY if `gemini-embedding-2` returns `404`/`503` (never mix spaces in the same collection—tag stored payloads with `embedModel`).

### Acceptance Criteria

- Unit test: Incoming `settings.qdrantEmbeddingModel = "text-embedding-004"` remaps to `"gemini-embedding-2"`, sends `outputDimensionality: 768`, and does NOT include `taskType` / `task_type`.

---

## S2: Multi-Sport `domains[]` Qdrant Filtering & CLV-Weighted Contrastive Retrieval

### Search Anchors

- `"No prior matching historical baselines"`, `"contrastiveWins"`, `"contrastiveLosses"`, `"appId"`, `"domains"`

### Required Changes

1. **Match Active `domains[]` on Multi-Sport Slates:**
   - When `domain === "multi-sport"` and `Array.isArray(domains) && domains.length > 0`, build the Qdrant filter using `should` / `match: { any: normalizedDomains }` (e.g., `["nfl", "nba", "nhl", "ncaaf"]`) instead of literal `domain === "multi-sport"`, while still keeping strict `appId === "duelodds"` isolation.
2. **Prioritize CLV + Outcome Contrastive Pairs:**
   - Support storing and retrieving `clv`, `sport`, `market`, `pillars`, and `vetoFlag` metadata in Qdrant point payloads.
   - Return up to `3` positive exemplars (`outcome === "won"` OR `clv > 0`) and `3` negative/cautionary exemplars (`outcome === "lost"` with `clv <= 0`, or repeated Critic veto patterns), deduplicated by `lessonId` / `eventId`.
   - Expose/verify an idempotent batch ingestion endpoint (e.g., `POST /cortex/ingest` or existing memory-upsert route behind Swarm auth) so `DuelOdds` can backfill its `112` `public.lessons` rows and stream newly graded CLV lessons automatically.

### Acceptance Criteria

- Unit test: A multi-sport request (`domain: "multi-sport", domains: ["nfl", "nhl"]`) builds a Qdrant filter matching `domain IN ["nfl", "nhl"]` + `appId: "duelodds"`, returning contrastive exemplars from both sports.
- Unit test: Batch ingest endpoint accepts structured lessons with `clv`, `sport`, `market`, `outcome`, and `lessonId`, generating deterministic point IDs so re-runs are idempotent.

---

## S3: Truthful `cortexSummary` Telemetry (No More Silent `404`s Masquerading as `"Success"`)

### Search Anchors

- `"cortexSummary"`, `"recordsFound"`, `"Cortex Retrieval Complete"`, `"HybridCortex"`

### Required Changes

- Expand `cortexSummary` emitted in SSE / diagnostics to include:
  - `collectionName`, `embedModel`, `collectionPointCount` (from Qdrant collection info, cached briefly), `appliedDomains`, `scoreThreshold`, `topRawScore`, and `embedError` / `qdrantError` (null when healthy).
- If embedding or Qdrant fails (e.g., `404`, `401`, `429`, timeout), set `status: "Error"` (NEVER `"Success"`) with the sanitized error message so Flight Recorder briefs surface memory failures immediately.

### Acceptance Criteria

- Unit test: A mocked `404` from `embedContent` produces `cortexSummary.status === "Error"` with populated `embedError` (never `"Success"`).
- Unit test: Healthy retrieval with 0 hits reports `status: "Empty"` (or `"Success"`) alongside `collectionPointCount`, `appliedDomains`, and `topRawScore`.

---

## Verification Commands

```powershell
npx tsc --noEmit
npx vitest run
```
