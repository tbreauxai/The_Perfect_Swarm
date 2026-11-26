# Engineering Fix Spec — `The_Perfect_Swarm` (`wf-1795719254817`: Instant `402` Cooldown, Non-Poisoning Verification Retries, Opponent Venue Guard & Gemini 4 Output Budget)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits and zero SQL migrations.
**Baseline:** `a1` `gemini-4-hydrogen` (`9.45s`), `critic` `gpt-oss-120b` (`1.28s`), S1 fail-closed invariants, S2 failover diagnostics, and S3 sport-scoped team names are verified live. Do NOT re-audit them.
**Observed Failures (`wf-1795719254817`):**
1. Mistral `HTTP 402` failed in `377ms` on Pass 1, then was retried on Verification Attempt 2 and burned `20,505ms` before failing over.
2. A Manager Attempt 1 prose error (`Texas Tech Red Raiders spread mismatch: cited -10, authoritative -14.5`) added a Pass 1 Critic-approved leg (`R10`) to permanent `vetoedLegs`, forcing Attempt 2 to fail with `"Vetoed leg (Texas Tech Red Raiders) must be removed from picks"`; venue check also falsely flagged unpicked opponent `Philadelphia Eagles` inside a Cowboys pick.
3. `a1` (`gemini-4-hydrogen`) truncated mid-sentence (`"...(-2.5 to -3), though"`) and emitted no parsed `picks[]` in `interimDigests`.

---

## Execution Rules & Token-Saving Guardrails
1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `fix/swarm-wf-1795719254817`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Zero-Retry Instant Cooldown on HTTP `401` / `402` / `403` Billing & Auth Errors

### Observed Failure (`wf-1795719254817`)
- `mistral/mistral-small-2603` returned `HTTP 402` in `377ms` on Manager Pass 1, then was retried on Manager Verification and stalled for `20,505ms` (`durationMs: 20505`) before failing over.

### Search Anchors
- `"402"`, `"Mistral API Error"`, `"cooldown"`, `"model on cooldown"`, `"retry"`

### Required Changes
- Treat HTTP `401`, `402`, and `403` (and `429` with `limit: 0` / billing exhausted) as **non-retryable** across all provider clients:
  - Abort immediately on the first response (zero retry loop, zero exponential backoff).
  - Place `(provider, model)` (and the provider for `401`/`402`) on a `30-minute` in-memory cooldown so Attempt 2 / Verifier skips it in `0ms` with a `[BILLING_COOLDOWN_SKIP]` entry in `diagnostics.failovers`.

### Acceptance Criteria
- Unit test: A mocked `HTTP 402` from Mistral aborts in `< 50ms` (1 fetch total, no retries), triggers immediate failover, and causes a second call within the same workflow to skip Mistral in `0ms` with `[BILLING_COOLDOWN_SKIP]`.

---

## S2: Do Not Permanently Veto Critic-Approved Legs on Fixable Verification Prose Typos + Harden Spread & Opponent Venue Checks

### Observed Failures (`wf-1795719254817`)
- Pass 1 Risk Critic approved `R10` (`anomalies: []`). Verification Attempt 1 flagged `Texas Tech Red Raiders spread mismatch: cited -10, but authoritative tool/row spread is -14.5`, then locked `Texas Tech Red Raiders` into `vetoedLegs` so Attempt 2 failed with `"Vetoed leg (Texas Tech Red Raiders) must be removed from picks"` even after correcting the text.
- Attempt 2 also failed with `"Philadelphia Eagles venue mismatch: described as home, but Philadelphia Eagles is the away team"` when `Dallas Cowboys` (`R1`/`R13`) was the picked team and `Philadelphia Eagles` was only the opponent.

### Search Anchors
- `"CRITIC AUDIT spread mismatch"`, `"Vetoed leg ("`, `"must be removed from picks"`, `"venue mismatch"`, `"described as home"`

### Required Changes
1. **Separate Pass 1 Leg Vetoes From Attempt 1 Manager Prose Corrections:**
   - Only legs vetoed by Pass 1 Risk Critic or Pass 1 deterministic grounding checks (`contra_steam_misread`, `symmetric_injury_misread`, `sharp_contra_steam`, `row_side_mismatch`) belong in the permanent `vetoedLegs` exclusion set (`"must be removed from picks"`).
   - Verification Attempt 1 prose/formatting issues on a Critic-approved leg (`spread mismatch`, `venue mismatch`) are **repairable feedback** for Manager Attempt 2—do NOT add that leg to `vetoedLegs` so Manager can fix the wording and keep the valid leg on Attempt 2.
2. **Prevent Row-ID / Odds False Matches in `spread mismatch`:**
   - When extracting cited spreads next to a team name, exclude row IDs (`R10`, `(R10)`), American odds (`(-110)`, `(-108)`), win-loss records (`4-1`, `8-2`), and net margins (`+7.0 net margin`, `-2.0 net margin`).
3. **Restrict `venue mismatch` to the Picked Team's Own Direct Venue Claims (Never Misattribute Home/Away Across Opponent Clause):**
   - Only run `venue mismatch` against the **picked side's team** (or explicit standalone subject clauses like `"Philadelphia Eagles at home"` / `"home team Philadelphia Eagles"`), NEVER attributing `"Dallas home edge over Philadelphia Eagles"` or `"at home against Philadelphia Eagles"` to the away opponent.

### Acceptance Criteria
- Unit test (non-poisoning retry): Pass 1 Critic approves `R10` (`Texas Tech -14.5`). Attempt 1 Manager cites `-10` -> Verifier returns repairable feedback WITHOUT adding `Texas Tech Red Raiders` to `vetoedLegs`. Attempt 2 fixes prose to `-14.5` -> Verification passes (`success: true`, `R10` kept).
- Unit test (spread regex): `"Texas Tech Red Raiders (R10) at (-110) with -2.0 opponent net margin"` produces **0** spread mismatch.
- Unit test (opponent venue): Pick `R1` (`Dallas Cowboys -8.5`) with prose `"Dallas Cowboys hold a home advantage against Philadelphia Eagles"` produces **0** `Philadelphia Eagles venue mismatch`.

---

## S3: Raise Gemini 4 (`gemini-4-*`) `maxOutputTokens` to `>= 4096` to Prevent Thinking-Budget JSON Truncation

### Observed Failure (`wf-1795719254817`)
- `a1` (`gemini-4-hydrogen`) finished in `9.45s` (`status: "ok"`), but its output cut off mid-sentence (`"...moving toward the Bills (-2.5 to -3), though"`) with zero parsed `picks[]` in `interimDigests`.

### Search Anchors
- `"gemini-4-"`, `"maxOutputTokens"`, `"thinkingConfig"`, `"thinkingLevel"`

### Required Changes
- For all `gemini-4-*` and `gemini-3.*` thinking-capable models, set `generationConfig.maxOutputTokens = Math.max(configuredMaxTokens, 4096)` (thinking tokens count against `maxOutputTokens` on the Gemini API).
- Verify that if `finishReason === "MAX_TOKENS"` or parsed `picks` fails JSON parsing on `a1`/`a2`, the seat does not silently succeed with truncated prose and empty `picks`.

### Acceptance Criteria
- Unit test: `gemini-4-hydrogen` request payload sets `generationConfig.maxOutputTokens >= 4096` alongside `thinkingConfig: { thinkingLevel: "low" }`.
- Unit test: A mocked `gemini-4-hydrogen` response with `finishReason: "MAX_TOKENS"` and truncated JSON triggers failover/retry rather than silently succeeding with `picks: []`.

---

## Verification Commands
```powershell
npx tsc --noEmit
npx vitest run
```