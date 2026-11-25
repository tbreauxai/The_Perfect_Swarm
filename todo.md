# Engineering Fix Spec — `The_Perfect_Swarm` (Eliminate Groq 144s TPM Bottleneck, Gemini 3.x Param Hygiene & `run_timeout` Telemetry)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits and zero SQL migrations.
**Confirmed Root Cause (`wf-1795624413788` = `195s`, `wf-local-...-e7r1nu` = `246s run_timeout`):**
- Hop-1 tools + Quant (`20.3s`) + Market (`9.8s`) all completed fast.
- **Groq ate `144.1s` (74% of runtime):** Risk Critic Pass 1 (`36.4s`) -> Manager failed over 3 Gemini models in `~8s` and slept `~49s` on Groq `openai/gpt-oss-120b` -> Critic Verification slept `~58.7s` on the exact same Groq `6,000 TPM` bucket.

---

## Execution Rules & Token-Saving Guardrails
1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `fix/swarm-groq-tpm-latency`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Eliminate 50–60s Groq TPM Sleeps (Fast-Skip Bucket Gate + Per-Model Buckets + Low Reasoning Effort)

### Observed Failure (`wf-1795624413788`)
- `tokenBudgets.groq.tpmLimit` is a single shared `6000` TPM bucket across all Groq models.
- Manager failover and Critic Verification both blocked for `49s` and `58.7s` waiting on Groq's bucket instead of routing to a `0ms`-wait provider (`cloudflare` 30K TPM, `mistral` 30K TPM, `openrouter` 25K TPM) or a separate Groq model bucket.

### Search Anchors
- `"tpmLimit"`, `"tokenBudgets"`, `"openai/gpt-oss-120b"`, `"6000"`, `"Failover"`, `"Critic verification"` / `"Verifier"`

### Required Changes
1. **Add a Hard Failover Wait Cap (`maxWaitMs = 5000`) on Token-Bucket Acquire:**
   - When selecting a failover provider (for Manager, Critic, or Verifier), check the candidate provider's estimated bucket wait time BEFORE sleeping.
   - If `estimatedWaitMs > 5000` (e.g., Groq needs `45,000ms` to refill) AND another healthy failover provider has `estimatedWaitMs <= 5000`, **immediately skip the throttled provider** (logging `"skipped_tpm_wait: <ms>ms"`) instead of sleeping 45–59 seconds.
2. **Prefer High-TPM Providers Ahead of Groq for Manager Failover:**
   - Order Manager failover as: `Gemini primary -> Gemini sibling(s) -> Cloudflare -> Mistral -> OpenRouter -> Groq -> NVIDIA` (putting Groq behind `30K TPM` Cloudflare/Mistral so Manager never collides with Risk Critic's `8K TPM` Groq window).
3. **Decouple Critic Verification From Risk Critic Pass 1's Groq Bucket:**
   - Track Groq token buckets **per `(provider, model)`** rather than a single global `groq` bucket (Groq enforces TPM per model: `openai/gpt-oss-120b` = `8,000 TPM`, `openai/gpt-oss-20b` = separate `8,000 TPM`, `llama-3.3-70b-versatile` = separate `12,000 TPM`).
   - Route **Critic Verification** to a provider/model that did NOT just run Risk Critic Pass 1:
     - First choice: fast `0ms`-wait `Gemini` (`gemini-3.5-flash-lite` / `3.1-flash-lite`) or `Cloudflare` (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) or a separate Groq model (`openai/gpt-oss-20b` / `llama-3.3-70b-versatile`), so Verification runs in `~3–8s` instead of sleeping `58.7s` behind Pass 1.
4. **Cap Reasoning Overhead on Groq `openai/gpt-oss-120b`:**
   - Pass `reasoning_effort: "low"` (and sensible `max_completion_tokens <= 1500`) on Groq `openai/gpt-oss-120b` JSON critic/verifier calls so hidden reasoning tokens don't blow through the `8,000 TPM` window on a single 1,400-token prompt.

### Acceptance Criteria
- Unit test (fast-skip): When Groq's bucket requires `45,000ms` wait and Cloudflare/Mistral has `0ms` wait, Manager failover skips Groq in `< 50ms` and completes on Cloudflare/Mistral.
- Unit test (per-model Groq buckets): Draining `groq:openai/gpt-oss-120b` does NOT block `groq:openai/gpt-oss-20b` or `groq:llama-3.3-70b-versatile`.
- Unit test (Groq request): Calls to `openai/gpt-oss-120b` include `reasoning_effort: "low"` and `max_completion_tokens <= 1500`.

---

## S2: Audit Gemini 3.x Request Params & Log Exact Per-Hop Failover Status/Errors

### Observed Gap (`wf-1795624413788`)
- Manager failed over all 3 Gemini models (`3.1-flash-lite -> 3.5-flash-lite -> 3.8-flash`) in `~8s` total.

### Search Anchors
- `"gemini-3.5-flash-lite"`, `"gemini-3.1-flash-lite"`, `"gemini-3.8-flash"`, `"thinking_budget"`, `"thinking_level"`, `"Failover"`

### Required Changes
1. **Verify Gemini 3.x / 4.x Payload Hygiene:**
   - Inspect the Gemini request builder: strip any deprecated Gemini 2.5 parameters (`thinking_budget`, unsupported sampling fields) when calling `gemini-3.*` or `gemini-4-*` models; use `thinking_level: "low"` (or omit) for fast JSON compilation on Gemini 3.x/4.x.
2. **Surface Exact Error Status & Message on Every Failover Event:**
   - In every failover SSE/log event, include `{ fromProvider, fromModel, status, errorSnippet }` (truncated `<= 160` chars, secrets redacted) so Flight Recorder immediately reveals whether Gemini returned `400` (bad param), `429` (quota), or `503` (overload).

### Acceptance Criteria
- Unit test: Gemini request builder omits `thinking_budget` on `gemini-3.5-flash-lite` / `gemini-3.8-flash` / `gemini-4-hydrogen`.
- Unit test: Mocked `400` or `503` from Gemini records the exact HTTP status and snippet in the failover event payload.

---

## S3: Emit Structured Diagnostics When `run_timeout` Fires

### Observed Gap (`wf-local-20261125175946-e7r1nu`)
- `run_timeout` closed the SSE stream with only `"[Swarm Error] run_timeout"`, omitting `workflowId`, `lastStage`, `activeSeat`, and `elapsedMs`.

### Search Anchors
- `"run_timeout"`, `"Swarm Error"`

### Required Changes
- Before closing the SSE stream on `run_timeout`, emit a structured error payload containing `{ error: "run_timeout", workflowId, lastStage, activeSeat, activeProvider, activeModel, elapsedMs }` so timeouts immediately name the stalled stage/provider.

### Acceptance Criteria
- Unit test: Triggering `run_timeout` while a seat is in flight emits `workflowId`, `activeSeat`, `activeProvider`, `activeModel`, and `elapsedMs` in the error event.

---

## Verification Commands
```powershell
npx tsc --noEmit
npx vitest run
```