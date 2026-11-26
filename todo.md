# Engineering Spec — `The_Perfect_Swarm` (Live Free-Tier Model Discovery Endpoint Using Render `process.env` Keys)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits and zero SQL migrations.
**Architecture:** All provider API keys live on Render (`process.env`), NOT in `DuelOdds`. `The_Perfect_Swarm` exposes a live, cached model-discovery route that `DuelOdds` proxies via `/api/proxy/swarm/models/live`.

---

## Execution Rules & Token-Saving Guardrails

1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `feat/swarm-live-models`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Add Live Free-Tier Model Discovery Endpoint (`GET /models/live` & `GET /api/models/live`)

### Search Anchors

- `"/stream"`, `"/health"`, `"GEMINI_API_KEY"`, `"NVIDIA_API_KEY"`, `"GROQ_API_KEY"`, `"MISTRAL_API_KEY"`, `"OPENROUTER_API_KEY"`

### Required Changes

1. **Expose Route Matching Existing Swarm Route Prefix:**
   - Inspect how `/stream` (e.g., `/api/swarm/stream` or `/swarm/stream`) is mounted on the HTTP server, and mount `GET .../models/live` (and alias `/api/models/live`) behind the same auth middleware used by `/stream`.
   - Accept `?provider=gemini|nvidia|groq|mistral|openrouter|cloudflare` (and optional `?refresh=true` to bypass the `6h` in-memory cache; optional `?probe=true` for manual 1-token Gemini free-tier check).
   - Never leak or echo any `process.env` API key values in responses or error strings.
   - Return normalized JSON:
     ```json
     {
       "provider": "gemini",
       "keyConfigured": true,
       "source": "live_api+official_pricing_md",
       "verifiedAt": "2026-11-26T01:44:00.000Z",
       "models": [
         {
           "id": "gemini-4-hydrogen",
           "label": "Gemini 4 Hydrogen",
           "freeTierVerified": true,
           "supportsThinking": true,
           "inputTokenLimit": 1048576
         }
       ]
     }
     ```
2. **Per-Provider Live Discovery Using Render `process.env` Keys (6-Hour In-Memory Cache):**
   - **Gemini (`process.env.GEMINI_API_KEY`):**
     - Fetch `https://ai.google.dev/gemini-api/docs/pricing.md.txt` and parse model IDs whose Free Tier column states `Free of charge` (and NOT `Not available`).
     - Fetch `GET https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}&pageSize=100`, filter to `supportedGenerationMethods.includes("generateContent")` excluding `/embedding|imagen|veo|lyria|tts|native-audio|robotics|aqa/i` (do **NOT** filter by `/flash|pro/i`, which drops `gemini-4-hydrogen`).
     - Intersect live `/v1beta/models` against the `pricing.md.txt` free-tier set (if `GEMINI_API_KEY` is absent, still return `pricing.md.txt` free models with `keyConfigured: false`).
     - Only when `?probe=true` is explicitly requested: run a 1-token `maxOutputTokens: 1` check on unclassified chat models (`200` -> `freeTierVerified: true`, `429` with `free_tier` + `limit: 0` -> `freeTierVerified: false`).
   - **NVIDIA (`process.env.NVIDIA_API_KEY`):**
     - Fetch `GET https://integrate.api.nvidia.com/v1/models` with `Authorization: Bearer ${NVIDIA_API_KEY}`, excluding `/embed|rerank|parse|ocr|guard|shield|cosmos|sdxl|flux|canary|parakeet|riva|deplot|paligemma|vila|neva/i`.
     - If `NVIDIA_API_KEY` is missing or upstream fails, fall back to `https://models.dev/api.json` (`nvidia` text-chat models) so the endpoint still returns live NVIDIA models.
   - **Groq (`process.env.GROQ_API_KEY`):**
     - Fetch `GET https://api.groq.com/openai/v1/models`, excluding `/whisper|tts|playai|guard|safeguard|embed/i`.
   - **Mistral (`process.env.MISTRAL_API_KEY`):**
     - Fetch `GET https://api.mistral.ai/v1/models`, excluding `/embed|ocr|moderation|voxtral/i`.
   - **OpenRouter:**
     - Fetch `GET https://openrouter.ai/api/v1/models` and filter strictly to `Number(pricing?.prompt) === 0 && Number(pricing?.completion) === 0` (or `:free` IDs).
   - **Cloudflare:**
     - Query Cloudflare Workers AI text-generation models if `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` are set, otherwise return the active Workers AI text-gen list (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, etc.).

### Acceptance Criteria

- Unit test (Gemini): Intersecting `/v1beta/models` with `pricing.md.txt` includes `gemini-4-hydrogen` (`freeTierVerified: true`) and excludes paid-only `gemini-4-carbon` / `gemini-4-argon` and `gemini-embedding-001`.
- Unit test (NVIDIA): Uses `process.env.NVIDIA_API_KEY`, filters out embed/rerank/OCR models, and falls back to `models.dev` if `NVIDIA_API_KEY` is unset.
- Unit test (OpenRouter): Returns strictly zero-cost (`prompt === "0" && completion === "0"`) models.
- Unit test (caching): Second call within `6h` serves from memory (`0` upstream fetches); `?refresh=true` forces a fresh fetch.

---

## Verification Commands

```powershell
npx tsc --noEmit
npx vitest run
```
