# Engineering Fix Spec — `The_Perfect_Swarm` (`wf-1795642034571`: Venue-Mismatch False Positives, `Tier-1 Q` Calibration & `a1` Timeout Cooldown)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits and zero SQL migrations.
**Baseline:** Contra-steam / split-seat guard, `15s` NVIDIA timeout, `gemini-3.5-flash-lite` Verifier routing, and `7/20` partial-log injury weighting are verified live. Do NOT re-audit them.
**Observed Failures (`wf-1795642034571`):**

1. Verifier failed Attempt 1 (`"Philadelphia Flyers venue mismatch: described as home"`) AND Attempt 2 (`"Washington Capitals venue mismatch: described as away/road"`) even though Attempt 2's `picks` contained ONLY `R4` (`Minnesota Wild`), and failed-verification output left contradictory `picks: [R4]`, `wageringPass: false`, and `scorecards[2]: approve`.
2. Role players (`Sion James`, `Jalen Smith`, `Jimmy Snuggerud`, `Declan Carlile`) were tagged `Tier-1 Q`, flipping `nhl-401892785` (`NYI vs STL`) to `uncertain_questionable`.
3. `nvidia/nemotron-3-ultra-550b-a55b` timed out at `15s` on back-to-back runs before `gemini-3.5-flash-lite` answered cleanly.

---

## Execution Rules & Token-Saving Guardrails

1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `fix/swarm-wf-1795642034571`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Fix False-Positive `venue mismatch` Proximity Matcher & Clean Fail-Closed State on Verification Exhaustion

### Observed Failure (`wf-1795642034571`)

- Attempt 1 failed: `"Veto: SPREAD SIDE mismatch — Philadelphia Flyers venue mismatch: described as home, but Philadelphia Flyers is the away team"`
- Attempt 2 failed: `"Veto: SPREAD SIDE mismatch — Washington Capitals venue mismatch: described as away/road, but Washington Capitals is the home team"` (despite `picks` holding ONLY `R4` `Minnesota Wild`!).
- On exhausted retries (`verification.success === false`), payload emitted `verified: false, criticApproved: false` alongside `wageringPass: false`, `picks: [R4]`, `summary: "...picks=2..."`, and `Risk Critic` scorecard `verdict: "approve"`.

### Search Anchors

- `"venue mismatch"`, `"SPREAD SIDE mismatch"`, `"described as home"`, `"described as away/road"`, `"Exhausted 2 retries"`

### Required Changes

1. **Scope Venue Checks Strictly to Same-Clause Direct Modifiers on Picked Games:**
   - Run `venue mismatch` validation ONLY against `event_id`s actually present in `compiled.picks` (never reject a `Minnesota Wild`-only payload over prose/scorecard text mentioning `Washington Capitals` or `Philadelphia Flyers`).
   - Within a picked game's reason/analysis, split text into clauses (on `.`, `;`, `,`, `vs`, `over`, `against`, `versus`, `while`, `and`, `at`) BEFORE checking venue words.
   - Trigger `venue mismatch` ONLY when a venue term directly modifies that specific team within the same clause (e.g., `"<Team> at home"`, `"<Team>'s home record"`, `"home <Team>"`, `"<Team> on the road"`, `"road <Team>"`, `"away <Team>"`) — NEVER attach Team A's `"away advantage"` or `"home record"` to Team B across `"over <Team B>"` or `"against <Team B>"`.
2. **Reconcile Fail-Closed Payload Fields When Verification Exhausts Retries:**
   - When `verification.success === false` after max attempts, fail closed cleanly across every field:
     - `picks: []`, `wageringPass: true`, `criticApproved: false`, `verified: false`, `pass: true`, `status: "no_play"`
     - Update the `Risk Critic` scorecard entry to `verdict: "veto"` with the deduplicated failure reason
     - Regenerate `summary` / `analysis` for the 0-pick pass so it never prints stale `"picks=2"` or recommends a pick that failed verification.

### Acceptance Criteria

- Unit test (false-positive regression):
  - `"Philadelphia Flyers hold an away advantage over Washington Capitals"` -> **0** venue mismatch on either team.
  - `"Minnesota Wild boasts a strong home record; Philadelphia Flyers hold a road edge over Washington Capitals"` -> **0** venue mismatch on either team.
  - `picks: [{ row: "R4", side: "Minnesota Wild" }]` with `"Washington Capitals"` only in an unpicked scorecard note -> **0** Capitals venue mismatch.
- Unit test (true-positive guard):
  - `picks: [{ row: "R115", side: "Philadelphia Flyers", reason: "Philadelphia Flyers have a dominant home record tonight" }]` -> DOES trigger `Philadelphia Flyers venue mismatch`.
- Unit test (exhausted retries): Emits `picks: []`, `wageringPass: true`, `criticApproved: false`, `verified: false`, and `Risk Critic` scorecard `verdict: "veto"`.

---

## S2: Tighten `Tier-1 Q` Star Thresholds & Prevent Unlogged/DNP Players From Being Misclassified

### Observed Failure (`wf-1795642034571`)

- `Sion James` (CHA), `Jalen Smith` (CHI), `Jimmy Snuggerud` (STL), and `Declan Carlile` (PIT) were labeled `Tier-1 Q`, turning `nhl-401892785` (`NYI vs STL`), `nba-401909318`, and `nhl-401892786` into `uncertain_questionable`.
- `nhl-401892781` (`WPG 4 OUT [impact 2.0: 4 depth]`) and `nhl-401892786` (`CGY 3 OUT [impact 1.5: 3 depth]`) still scored `0.5 depth` on 1-game teams.

### Search Anchors

- `"Tier-1 Q"`, `"uncertain_questionable"`, `"get_injury_and_roster_delta"`, `"espn_depthchart"`, `"depth"`

### Required Changes

1. **Reserve `Tier-1` (and `Tier-1 Q` Veto Flag) Strictly for High-Usage Stars / Starting QBs / Starting Goalies:**
   - **NBA Tier-1:** `avgMinutes >= 28` AND (`avgPoints >= 18` OR `avgPRA >= 28`), OR `avgMinutes >= 31` high-usage primary starter. Regular rotation starters / bench pieces (`Sion James`, `Jalen Smith`, `< 26` MPG or `< 15` PPG) MUST classify as **Tier-2** (`1.5–2.0`) or **depth** (`0.5`), NEVER `Tier-1 Q`.
   - **NHL Tier-1:** Starting Goalie (`position === "G"` with `goalie_starts >= 1` or `depth_rank === 1`) OR top-line skater (`avgToi >= 19.5` min AND `pointsPerGame >= 0.70`, or `avgToi >= 21.5` top-pair defenseman). Depth defensemen (`Declan Carlile`) and middle-six skaters (`Jimmy Snuggerud`) MUST classify as **Tier-2** or **depth**, NEVER `Tier-1 Q`.
   - **NFL Tier-1:** Starting `QB` (`depth_rank === 1`), high-volume skill player (`targets >= 7` or `rush_attempts >= 12`), or starting `LT`/`EDGE` (`depth_rank === 1`).
   - Do **NOT** auto-promote non-QB / non-G `espn_depthchart` rows (`depth_rank === 1`) to `Tier-1` without corroborating star usage stats (classify uncorroborated `depth_rank === 1` skaters/NBA starters as **Tier-2**, not `Tier-1 Q`).
2. **Treat `0`-Minute / `0`-TOI Boxscore Entries as `unlogged` (`1.0`), Not `depth` (`0.5`):**
   - If a player's logged boxscore row has `minutes === 0` or `toi === 0` (DNP-CD / injury-list row) and the team has `< 5` distinct `game_date`s, score them as neutral `1.0` (`unlogged`) rather than `0.5` (`depth`).

### Acceptance Criteria

- Unit test: `Jimmy Snuggerud` (depthchart `depth_rank: 1`, no star TOI/PPG) and `Declan Carlile` (low TOI D-man) classify as `Tier-2` / `depth`, NOT `Tier-1 Q` -> `nhl-401892785` (`NYI vs STL`) resolves as `home_advantage (New York Islanders)`, not `uncertain_questionable`.
- Unit test: `Joel Embiid` (`32` MPG, `27` PPG) and `Evgeni Malkin` (`20` TOI, `0.9` PPG) still trigger `Tier-1 Q`.

---

## S3: Add Soft Cooldown After Consecutive `a1` NVIDIA Timeouts (Stop Paying 15s Penalty Every Run)

### Observed Timings (`wf-1795638625511` & `wf-1795642034571`)

- `nvidia/nemotron-3-ultra-550b-a55b` timed out on back-to-back 20-game runs (`28s`, then `15s`), adding `16.3s` dead wait before `gemini-3.5-flash-lite` answered cleanly.

### Search Anchors

- `"NVIDIA request timed out"`, `"15000"`, `"cooldown"`, `"diagnostics"`

### Required Changes

- Track consecutive timeout counts per `(provider, model)` in memory.
- After `2` consecutive timeouts on a model (or `1` timeout when `inputTokens > 6000`), apply a `10-minute` soft cooldown on that model so subsequent heavy-slate runs skip straight to the healthy failover (`gemini-3.5-flash-lite`) in `0ms` (recording a `[COOLDOWN_SKIP]` entry in `diagnostics.failovers` for visibility) instead of waiting `15,000ms` every run.

### Acceptance Criteria

- Unit test: After `nvidia/nemotron-3-ultra-550b-a55b` times out on an `8,000`-token call, the next call within 10 minutes skips straight to `gemini-3.5-flash-lite` in `< 50ms` and logs `[COOLDOWN_SKIP]` in `diagnostics.failovers`.

---

## Verification Commands

```powershell
npx tsc --noEmit
npx vitest run
```
