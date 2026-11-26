# Engineering Spec — `The_Perfect_Swarm` (Deterministic-Only Verifier, 15s Zero-Retry Timeouts, Non-Google Failover Order, Partial-Veto Survival & Clean `/models/live` Catalog)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero edits to `DuelOdds` and zero SQL migrations.
**Observed Failures (`wf-1795734233660` & `/models/live` audit):**

1. `verifier` mirrored `critic`'s model (`kimi-k3.1-pro`), burning `90.0s` on a second timeout cascade and falling over to `gemini-4-hydrogen` (burning precious Hydrogen quota on verification).
2. Single-seat timeouts retried multiple times (`86.0s` on `critic`, `90.0s` on `verifier`) without putting the timed-out model on cooldown after Attempt 1.
3. Pass 1 Critic approved `a1`'s `R9` (`Buffalo Bills ML`) while vetoing `a2`'s `R5` (`symmetric_injury_misread`), yet full-slate veto logic wiped `R9` out too; additionally, `symmetric_injury_misread` scanned across `|`-delimited legs inside `"- [Market Proposer] Proposed 3 leg(s): R5 ... | R2 ..."`.
4. Cloudflare `/models/live` mapped full `description` sentences into dropdown `label`s, and non-chat models (TTS/vision/guard/PII/calibration) leaked into the live dropdowns.

---

## Execution Rules & Token-Saving Guardrails

1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `feat/deterministic-verifier-and-failover-hygiene`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Replace LLM Verifier With Pure Deterministic TypeScript Verification (`0` LLM Calls)

### Search Anchors

- `"verifier"`, `"Verification FAILED"`, `"RLAIF Rating"`, `"verification"`, `"attempts"`

### Required Changes

1. **Remove the Post-Manager LLM Call From Verification:**
   - Replace the LLM-based verification step after `manager` with a fast, synchronous/pure-TypeScript deterministic verifier (`durationMs <= 5ms`, `0` tokens, `0` provider calls, `provider: "local"`, `model: "deterministic-verifier"` in `diagnostics.seatTimings`).
   - Run all deterministic checks in one pass:
     - Valid top-level JSON object with required keys (`summary`, `picks`, `scorecards`, `components`, `criticApproved`, `wageringPass`).
     - Every pick in `picks[]` references a valid board `R#` row ID and matches the board's side/market.
     - Zero Pass 1 vetoed legs (`vetoedRowIds`) appear in `picks[]` or are recommended in `summary`/`analysis`.
     - Strict mutual exclusion: if `picks.length > 0`, `wageringPass` MUST be `false`; if `summary`/`analysis`/`DataTable` recommends wagers while `picks` is empty, fail with repairable schema feedback.
     - All existing grounding checks (split-aware record/form check, spread/venue checks, contra-steam check, negation-aware `symmetric_injury_misread`).
2. **Keep the Single Repair Loop Back to `manager`:**
   - If deterministic verification finds repairable errors on Attempt 1, pass the exact deterministic feedback back to `manager` for 1 repair attempt, then re-verify deterministically (`0ms`).
   - Emit `verified: true, verification: { success: true, attempts, rating: 1.0 }` on pass, or fail closed (`picks: []`, `wageringPass: true`, `criticApproved: false`) if Attempt 2 still violates deterministic rules.

### Acceptance Criteria

- Unit test: Clean `manager` output passes verification with **0** LLM provider calls (`verifier` logs `provider: "local"`, `model: "deterministic-verifier"`, `durationMs < 50`).
- Unit test: `manager` output omitting `picks[]` or re-introducing a Pass 1 vetoed leg fails deterministic Attempt 1 with exact feedback, triggers 1 `manager` repair, and passes deterministically on Attempt 2 with **0** verifier LLM calls.

---

## S2: Cap Timeouts (`15s`–`18s`, Zero Retry on Timeout), Immediate Cooldown & Non-Google-First Failover Order

### Search Anchors

- `"request timed out"`, `"25000"`, `"COOLDOWN_SKIP"`, `"skipped_tpm_wait"`, `"failover"`, `"gemini-4-hydrogen"`

### Required Changes

1. **Zero Retry on Timeout + Immediate 10-Minute Cooldown:**
   - Cap single-attempt timeout for `nvidia`, `cloudflare`, `groq`, and `openrouter` calls at `18,000ms` (keep `a1` `gemini-4-hydrogen` at `20,000ms` so large slates don't clip).
   - When any provider throws `[TIMEOUT]` (AbortError), do **NOT** retry the same `(provider, model)` — immediately put it on a `10-minute` in-memory cooldown and move straight to the next failover candidate (`< 20s` worst-case failover instead of `86s–90s`).
2. **Non-Google-First Failover Chain & Protect `gemini-4-hydrogen` Quota:**
   - Order `manager` and `critic` failover chains to prefer non-Google providers first (`cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `groq/qwen/qwen3.8-27b`, `groq/openai/gpt-oss-20b`, `nvidia/nemotron-3.5-lightning-30b-a3b`), keeping `gemini/gemini-3.5-flash-lite` as last resort (skipping any provider already used by the primary seat if it just hit `skipped_tpm_wait`).
   - NEVER include `gemini-4-hydrogen` in any automatic failover chain for `critic`, `manager`, or `verifier` (reserve Hydrogen strictly for explicitly configured seats like `a1`).

### Acceptance Criteria

- Unit test (timeout): A hanging NVIDIA fetch aborts at `<= 18,000ms` (1 fetch call total, zero retries), places `(nvidia, model)` on cooldown, and fails over immediately without burning `86s`.
- Unit test (failover order): `manager` failover tries non-Google providers before `gemini-3.5-flash-lite` and NEVER selects `gemini-4-hydrogen`.

---

## S3: Partial-Veto Preservation & Pipe-Delimited Digest Isolation (Stop `a2` Vetoes From Nuking `a1`'s Clean Legs)

### Observed Failure (`wf-1795734233660`)

- `a1` proposed clean `R9` (`Buffalo Bills ML`); `a2` proposed invalid `R5`, `R2`, `R8`.
- `symmetric_injury_misread` scanned across `|` in `"- [Market Proposer] Proposed 3 leg(s): R5 TCU Horned Frogs (conf 0.7) - Steam and health advantage | R2 Kansas City Chiefs..."`, blaming `R2` for `R5`'s claim, and the partial veto escalated into a full-slate pass wiping out `a1`'s approved `R9`.

### Search Anchors

- `"Proposed"`, `"vetoedLegs"`, `"symmetric_injury_misread"`, `"criticApproved"`, `"no_play"`, `"The Risk Critic vetoed all proposed selections"`

### Required Changes

1. **Isolate Pipe-Delimited Digest Entries:**
   - Split per-leg summary lines on `|` (and newlines) before running per-pick grounding checks so leg `R5`'s rationale can never bleed into leg `R2` or `R8`.
2. **Preserve Surviving Valid Legs on Partial Vetoes:**
   - Track vetoed row IDs (`vetoedRowIds`) vs. surviving approved row IDs (`approvedRowIds`) per leg.
   - Only trigger full-slate `no_play` (`criticApproved: false`, `picks: []`, `wageringPass: true`) when **0** valid proposed legs survive Pass 1 Critic + deterministic checks.
   - When `vetoedRowIds.size > 0` AND `approvedRowIds.size > 0` (e.g., `R5`/`R2`/`R8` vetoed while `R9` survived cleanly), pass the surviving legs (`[R9]`) + the explicit exclusion list (`vetoedRowIds: [R5, R2, R8]`) to `manager` with `criticApproved: true` for the surviving subset so `manager` compiles `R9` cleanly instead of nuking the entire slate.

### Acceptance Criteria

- Unit test (`wf-1795734233660` fixture): `a1` proposes clean `R9` (`Buffalo Bills ML`); `a2` proposes `R5` (`"Steam and health advantage"` on symmetric TCU), `R2`, `R8` (`duplicate_leg`).
  - `R5` and `R8` are vetoed; `R5`'s `"health advantage"` does NOT bleed across `|` onto `R2`.
  - `R9` survives intact into `manager` and final output (`picks: [R9]`, `criticApproved: true`, `wageringPass: false`) rather than wiping the slate to `no_play`.

---

## S4: Clean Up `/models/live` Labels & Non-Chat Model Exclusions

### Search Anchors

- `"/models/live"`, `"cloudflare"`, `"integrate.api.nvidia.com"`, `"api.groq.com"`, `"pricing.md.txt"`

### Required Changes

1. **Fix Cloudflare Dropdown Labels:**
   - Set `label` to the concise model ID/slug (e.g., `meta/llama-3.3-70b-instruct-fp8-fast` or human-formatted model name from `model.name`), NEVER `model.description`.
2. **Tighten Non-Chat Exclusions Across All 4 Providers:**
   - **Gemini:** also exclude `/transcribe|audio|live/i`.
   - **Cloudflare:** also exclude `/guard|vision|coder|whisper|bge|m2m|resnet|detr|stable-diffusion|flux|melotts|deepgram|aura/i`.
   - **Groq:** also exclude `/orpheus|playai|whisper|tts|guard|distil-whisper/i`.
   - **NVIDIA:** also exclude `/gliner|pii|synthetic-video|ising-calibration|content-safety|nvclip|starcoder|laguna|embed|rerank|parse|ocr|guard|shield|cosmos|sdxl|flux|canary|parakeet|riva|deplot|paligemma|vila|neva/i`.

### Acceptance Criteria

- Unit test: Cloudflare model `{ name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", description: "Llama 3.3 70B quantized..." }` produces `id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"` and concise `label` (NOT the description paragraph).
- Unit test: `gemini-3.5-transcribe`, `llama-guard-3`, `canopylabs/orpheus-v1-english`, `fastino/gliner2-pii`, `nvidia/ising-calibration-1.5-31b`, and `nvidia/nvclip` are all excluded from `/models/live`.

---

## Verification Commands

```powershell
npx tsc --noEmit
npx vitest run
```
