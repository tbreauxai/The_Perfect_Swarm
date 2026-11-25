# Engineering Fix Spec — `The_Perfect_Swarm` (`wf-1795635950672`: Cross-Sport `row_side_mismatch`, `a1` Unparsed Output, Veto Dedupe & Verifier Scoping)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits and zero SQL migrations.
**Baseline:** `62.3s` total runtime, `gemini-3.5-flash-lite` 3.14s Manager synthesis, `diagnostics` block, and injury coverage parity are verified live. Do NOT re-audit them.
**Observed Failures (`wf-1795635950672`):**
1. Deterministic `row_side_mismatch` falsely vetoed `R4` (`ML Minnesota Wild(-150)` on `nhl-401892791`) by cross-matching `"Minnesota Wild"` to `nba-401909320` (`Minnesota Timberwolves`).
2. `Quant Proposer` (`a1`, `nvidia/nemotron-3-ultra-550b`) completed in `6.68s` with `"[Quant Proposer] unparsed output"` (`picksCount: 0`), marked `status: "ok"` instead of failing over — caused by `max_tokens <= 1800` truncating its reasoning stream before JSON output.
3. Pass output repeated the same `R4` veto string 9× (`3 prefixes × 3 joins`).
4. Critic Pass 1 slept `5,005ms` before `[LIMITER_SKIP]`, and Critic Verification received `11,457` input tokens on a 0-pick pass while routing through `gemini-3.1-flash-lite` (`503`) instead of `gemini-3.5-flash-lite`.

---

## Execution Rules & Token-Saving Guardrails
1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `fix/swarm-wf-1795635950672`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Fix Cross-Sport City-Collision Bug in `row_side_mismatch` (`Minnesota Wild` vs `Minnesota Timberwolves`)

### Observed Failure (`wf-1795635950672`)
- `a2` proposed `R4` (`Minnesota Wild`). The validator emitted:
  `Veto: Row side mismatch — Row R4 belongs to nhl-401892791 ("ML Minnesota Wild(-150)"), not nba-401909320 ("Minnesota Wild").`

### Search Anchors
- `"Row side mismatch"`, `"belongs to"`, `"row_side_mismatch"`

### Required Changes
1. **Validate Against the Cited Row's Own Event FIRST:**
   - When a pick cites `row: "R4"` (`nhl-401892791`, `Utah Mammoth @ Minnesota Wild`, `ML Minnesota Wild(-150)`), check whether `pick.side` matches `R4`'s own team (`Minnesota Wild`) BEFORE running cross-game event lookup.
   - If `pick.side` matches `R4`'s team (`Minnesota Wild`), it is a valid match for `nhl-401892791` — NEVER reject it by mapping `"Minnesota"` to another sport's event (`nba-401909320`, `Minnesota Timberwolves`).
2. **Require Mascot / Full-Name Disambiguation on Multi-Sport Slates:**
   - When resolving a team string to a slate event across multiple sports, score **full team name** (`Minnesota Wild`) and **unique mascot** (`Wild` vs `Timberwolves`, `Bulls` vs `Blackhawks`, `Knicks` vs `Islanders`/`Rangers`, `Clippers`/`Lakers` vs `Kings`/`Rams`, `Capitals` vs `Commanders`, `Jazz` vs `Mammoth`) strictly above shared city tokens (`Minnesota`, `Chicago`, `New York`, `Los Angeles`, `Washington`, `Utah`, `Boston`, `Dallas`).
   - Never match `"Minnesota Wild"` to `"Minnesota Timberwolves"` via shared city prefix `"Minnesota"` or shared abbr `"MIN"`.
   - If `pick.reasonSource` is a wrong cross-sport `event_id` while `pick.row` and `pick.side` BOTH agree on `nhl-401892791`, normalize `reasonSource` to `row` (`"R4"`) instead of falsely vetoing a valid pick as `row_side_mismatch`.

### Acceptance Criteria
- Unit test (`nhl-401892791` `Utah Mammoth @ Minnesota Wild` + `nba-401909320` `Minnesota Timberwolves @ Oklahoma City Thunder` on the same slate):
  - `row: "R4"`, `side: "Minnesota Wild"` produces **zero** `row_side_mismatch` veto (even if `nba-401909320` appears earlier in the slate map).
  - `row: "R4"`, `side: "Minnesota Timberwolves"` DOES trigger `row_side_mismatch`.
  - Same test for `New York Knicks` vs `New York Islanders` / `New York Rangers`, and `Chicago Bulls` vs `Chicago Blackhawks`.

---

## S2: Fix `a1` (`nvidia/nemotron-3-ultra-550b`) `"[Quant Proposer] unparsed output"` & Trigger Failover on Parse Failure

### Observed Failure (`wf-1795635950672`)
- `a1` completed in `6.68s`, logged `status: "ok"`, and emitted `"[Quant Proposer] unparsed output"` (`picksCount: 0`) because `max_tokens <= 1800` cut off Nemotron's reasoning output before its JSON block finished.

### Search Anchors
- `"unparsed output"`, `"nemotron"`, `"max_tokens"`, `"Quant Proposer"`, `"chat_template_kwargs"`

### Required Changes
1. **Fix Reasoning-Model Token Budget on NVIDIA (`nemotron`):**
   - For NVIDIA reasoning models (`nemotron-*`, `deepseek-r1*`, `qwq*`), either pass `chat_template_kwargs: { enable_thinking: false }` (or low-reasoning budget) when requesting structured JSON, OR set `max_tokens >= 4096` so reasoning tokens cannot truncate the JSON payload while keeping the `30s` single-attempt timeout intact.
2. **Treat `unparsed output` as Seat Failure -> Immediate Failover (Not `status: "ok"`):**
   - If a proposer seat (`a1` or `a2`) returns non-JSON / truncated / empty text (`unparsed output`), mark that attempt as `parse_failed` (NOT `status: "ok"` with `verdict: "pass"`) and fail over once to a fast JSON-capable model (`gemini-3.5-flash-lite` -> `cloudflare` -> `groq`), recording the failover in `diagnostics.failovers` with the truncated raw snippet (`<= 120` chars) so parse crashes are always visible and recovered automatically.

### Acceptance Criteria
- Unit test (NVIDIA request builder): `nvidia/nemotron-3-ultra-550b-a55b` does NOT truncate JSON with `max_tokens: 1800` alongside unconstrained thinking (`max_tokens >= 4096` or `enable_thinking: false`).
- Unit test (parse failover): When `a1` primary returns truncated `<think>...` with no valid JSON object, the orchestrator records a failover event (`reason: "unparsed_json"`) and recovers cleanly via `gemini-3.5-flash-lite` instead of emitting `"[Quant Proposer] unparsed output"` with `status: "ok"`.

---

## S3: Eliminate 9× Veto Spam, Fix `5s` `slot_wait_timeout` Stall & Scope Verifier (`11,457` Tokens -> `<= 3,000`)

### Observed Failures (`wf-1795635950672`)
1. `summary`, `analysis`, `reason`, `insights[1]`, and `scorecards[0].notes` repeated the exact `R4` veto message 9 times (`Veto:` + `Veto (GROUNDING):` + `Veto (PREMISE):` × 3).
2. Groq limiter waited `5,005ms` (`slot_wait_timeout`) before `[LIMITER_SKIP]` instead of checking estimated wait upfront and skipping in `0ms`.
3. Critic Verification (`seatTimings[4]`) sent `11,457` input tokens on a 0-pick pass and tried `gemini-3.1-flash-lite` (`503`) instead of `gemini-3.5-flash-lite`.

### Search Anchors
- `"Veto (GROUNDING):"`, `"Veto (PREMISE):"`, `"slot_wait_timeout"`, `"LIMITER_SKIP"`, `"gemini-3.1-flash-lite"`, `"Verifier"`

### Required Changes
1. **Emit Each Deterministic Veto Once (No Triple Prefixing or `| `-Joining Duplicates):**
   - For any single deterministic violation on `(rowId, flag)` (e.g., `R4` + `row_side_mismatch`), emit **1** canonical veto line (do NOT duplicate it across `Veto:`, `Veto (GROUNDING):`, and `Veto (PREMISE):`).
   - In the final pass-summary builder, normalize and deduplicate veto reasons by core text before joining so no sentence ever repeats in `summary`, `analysis`, `reason`, `insights`, or `scorecards[].notes`.
2. **Instant `0ms` Skip on Saturated Rate-Limiter Bucket:**
   - In the rate limiter's `acquire(..., maxWaitMs)` path, compute `estimatedWaitMs` BEFORE sleeping. If `estimatedWaitMs > maxWaitMs` (or no slot can open within `maxWaitMs`), reject/skip immediately (`< 50ms`) instead of sleeping for the full `5,000ms` before throwing `slot_wait_timeout`.
3. **Scope Verifier Input & Prefer `gemini-3.5-flash-lite`:**
   - Scope Critic Verification's slate/dossier strictly to the games referenced in `compiled.picks` (or compact pass summary ONLY when `compiled.picks.length === 0`) so Verification stays `<= 3,000` input tokens instead of `11,457`.
   - Route Verifier's Gemini preference to `gemini-3.5-flash-lite` ahead of `gemini-3.1-flash-lite` (avoiding `3.1-flash-lite`'s frequent `503` spikes).

### Acceptance Criteria
- Unit test (veto dedupe): A single `row_side_mismatch` on `R4` appears **exactly once** in `summary`, `analysis`, `reason`, and `scorecards[0].notes`.
- Unit test (limiter skip): When `estimatedWaitMs === 18000` and `maxWaitMs === 5000`, limiter skips in `< 50ms` (zero 5-second sleep).
- Unit test (Verifier scoping): Verifying a 0-pick pass or 2-leg parlay on a 20-game slate sends `<= 3,000` input tokens and selects `gemini-3.5-flash-lite` ahead of `gemini-3.1-flash-lite`.

---

## Verification Commands
```powershell
npx tsc --noEmit
npx vitest run
```