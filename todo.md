# Engineering Fix Spec — `The_Perfect_Swarm` (`wf-1795711383683`: Authoritative Critic Verdict Lock, Complete Failover Diagnostics & Sport-Scoped Team Resolution)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits and zero SQL migrations.
**Baseline:** `31.2s` end-to-end runtime, `10.3s` Attempt-1 `nemotron-3.5-lightning-30b-a3b` Manager synthesis, `1.72s` `gpt-oss-20b` Verifier, and per-pick grounding isolation are verified live. Do NOT re-audit them.
**Observed Failures (`wf-1795711383683`):**
1. Pass 1 Risk Critic returned `"approved"` (`anomalies: []`), yet Manager emitted `picks: [R9]` alongside a contradictory Risk Critic scorecard `{ criticApproved: true, wageringPass: false, verdict: "veto" }`. Post-processing flipped top-level `criticApproved: false` without clearing `picks` and omitted `wageringPass`, wiping out a valid bet.
2. Both `a1` (`gemini-4-hydrogen -> groq/gpt-oss-120b`, `2.66s`) and `critic (Pass 1)` (`groq/gpt-oss-120b -> cloudflare`, `2.48s`) recorded `status: "failover"` in `diagnostics.seatTimings`, yet `diagnostics.failovers` was `[]`.
3. `get_injury_and_roster_delta` mapped `Texas Tech Red Raiders` (`college-football-401856879`) to `Las Vegas Raiders` via cross-sport mascot matching.

---

## Execution Rules & Token-Saving Guardrails
1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `fix/swarm-wf-1795711383683`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Lock Authoritative Pass 1 Risk Critic Verdict & Enforce Strict `criticApproved` / `wageringPass` / `picks` Invariants

### Observed Failure (`wf-1795711383683`)
- Risk Critic Pass 1 approved `R9` (`anomalies: []`).
- Manager (`nemotron-3.5-lightning-30b-a3b`) returned `picks: [R9]`, `scorecards: [..., { seat: "Risk Critic", criticApproved: true, wageringPass: false, verdict: "veto" }]`, and omitted top-level `wageringPass`.
- Compiler post-processor flipped top-level `criticApproved: false` while keeping `picks: [R9]`.

### Search Anchors
- `"criticApproved"`, `"wageringPass"`, `"scorecards"`, `"verdict"`, `"Risk Critic"`, `"no_play"`

### Required Changes
1. **Do Not Let Manager Overwrite an Authoritative Critic Approval With a Hallucinated `"veto"`:**
   - Track authoritative `criticPass1Approved` + `deterministicVetoes` from Pass 1 Risk Critic and deterministic grounding checks.
   - When `criticPass1Approved === true` AND `deterministicVetoes.length === 0` AND `compiled.picks.length > 0` (every compiled leg was approved by Critic):
     - Keep top-level `criticApproved = true` and `wageringPass = false`.
     - Normalize the `Risk Critic` scorecard entry to `verdict: "approve"` (never let Manager's `verdict: "veto"` typo or a `Market Proposer` dissent override an actual Risk Critic approval).
2. **Always Emit Explicit Top-Level `wageringPass` & Enforce Mutual Exclusion:**
   - Always include boolean `wageringPass` at the top level of `rawFinalAnalysisPayload` (never omit it).
   - If `criticApproved === false` (genuine Risk Critic veto or exhausted verification retries), ALWAYS enforce `picks: []` and `wageringPass: true` so the payload can never emit `criticApproved: false` alongside non-empty `picks`.
   - If `criticApproved === true && picks.length > 0`, ALWAYS enforce `wageringPass: false`.

### Acceptance Criteria
- Unit test (`wf-1795711383683` fixture): Pass 1 Critic approved `R9` (`anomalies: []`); Manager outputs `picks: [R9]` with contradictory `Risk Critic` scorecard `{ criticApproved: true, verdict: "veto" }` and missing top-level `wageringPass` -> post-processor reconciles to `criticApproved: true`, `wageringPass: false`, `picks: [R9]`, and `Risk Critic` scorecard `verdict: "approve"`.
- Unit test (genuine veto): Pass 1 Critic vetoed `R9` -> post-processor enforces `criticApproved: false`, `wageringPass: true`, `picks: []`.

---

## S2: Record Every Failover / Skip Into `diagnostics.failovers[]` (Close Silent Failover Gap)

### Observed Failure (`wf-1795711383683`)
- `diagnostics.seatTimings` logged `status: "failover"` on `a1` (`gemini-4-hydrogen -> groq/gpt-oss-120b`) and `critic` (`groq/gpt-oss-120b -> cloudflare`), yet `diagnostics.failovers` was `[]`.

### Search Anchors
- `"diagnostics"`, `"failovers"`, `"seatTimings"`, `"LIMITER_SKIP"`, `"COOLDOWN_SKIP"`, `"Provider Failover"`

### Required Changes
- Audit every failover / fallback / cooldown / limiter-skip / parse-retry transition across `a1`, `a2`, `critic`, `manager`, and `verifier`.
- Ensure EVERY transition from configured `(provider, model)` to a different `(provider, model)` appends a structured entry to `diagnostics.failovers`:
  `{ seat, from: "${fromProvider}/${fromModel}", to: "${toProvider}/${toModel}", status: httpStatus ?? null, error: sanitizedSnippet(<= 160 chars), durationMs }`.
- Add a final safeguard before emitting `diagnostics`: if any `seatTimings` entry has `status === "failover"` (or executed on a different `provider/model` than configured) and has no matching entry in `diagnostics.failovers`, synthesize one from the seat's recorded failure reason so `failovers` can NEVER be `[]` when a seat failed over.

### Acceptance Criteria
- Unit test: Mocking `gemini-4-hydrogen` to fail with HTTP `400` or `429` or `[COOLDOWN_SKIP]` and recovering on `groq/openai/gpt-oss-120b` produces both `seatTimings[a1].status === "failover"` AND a matching `diagnostics.failovers` record with exact `from`, `to`, `status`, and `error`.

---

## S3: Scope Team Resolution in `get_injury_and_roster_delta` Strictly by Sport (Fix `Texas Tech Red Raiders` -> `Las Vegas Raiders`)

### Observed Failure (`wf-1795711383683`)
- `college-football-401856879` (`TCU Horned Frogs @ Texas Tech Red Raiders`) rendered `Summary: Las Vegas Raiders (0 OUT, 0 Q) vs TCU Horned Frogs (0 OUT, 0 Q)`.

### Search Anchors
- `"get_injury_and_roster_delta"`, `"Las Vegas Raiders"`, `"team_name"`, `"home_team"`, `"away_team"`

### Required Changes
- In `get_injury_and_roster_delta` (and any shared team-name normalizer it calls):
  - Prefer the exact `home_team` / `away_team` strings from the game record/snapshot (`Texas Tech Red Raiders`, `TCU Horned Frogs`) instead of passing them through a sport-agnostic pro mascot lookup.
  - Whenever canonical team lookup IS needed, filter strictly by the game's sport/league (`americanfootball_ncaaf` != `americanfootball_nfl`, `icehockey_nhl` != `americanfootball_nfl`, `basketball_nba` != `icehockey_nhl`) so shared mascots (`Raiders`, `Panthers`, `Cardinals`, `Giants`, `Kings`, `Jets`, `Rangers`, `Tigers`, `Bears`) can never cross sports.

### Acceptance Criteria
- Unit test (`college-football-401856879`, `Texas Tech Red Raiders` vs `TCU Horned Frogs`): Summary header renders `Texas Tech Red Raiders (0 OUT, 0 Q) vs TCU Horned Frogs (0 OUT, 0 Q)`, NEVER `Las Vegas Raiders`.
- Unit test (cross-sport mascots): `Carolina Panthers` (`nfl`) never maps to `Florida Panthers` (`nhl`); `Los Angeles Kings` (`nhl`) never maps to `Sacramento Kings` (`nba`).

---

## Verification Commands
```powershell
npx tsc --noEmit
npx vitest run
```