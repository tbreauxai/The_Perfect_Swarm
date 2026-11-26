# Engineering Fix Spec — `The_Perfect_Swarm` (`wf-1795722858714`: Missing Manager `picks[]` Guard & Recovery + NCAAF `1.0`-pt Spread Steam Threshold)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits and zero SQL migrations.
**Baseline:** `37.5s` Swarm runtime, `9.85s` `gemini-4-hydrogen` (`picks` parsed cleanly), `5.75s` `nemotron-3.5-lightning-30b-a3b` Manager, `2ms` limiter skip, and spread/venue fixes are verified live. Do NOT re-audit them.
**Observed Failures (`wf-1795722858714`):**
1. Manager (`nemotron-3.5-lightning-30b-a3b`) recommended `R1`, `R5`, and `R10` across `summary`, `analysis`, `components[2]` (`DataTable`), and `scorecards`, but omitted the top-level `"picks"` key completely. Post-processing silently flipped `wageringPass: true`, and Verification scored the contradictory payload `0.98` (success) on Attempt 1.
2. `get_market_movement` printed `Steam: neutral (1 pts)` on `college-football-401856879` despite a `-15.5 -> -14.5` (`Delta: 1`) spread move and `-820 -> -670` ML move against Texas Tech, disagreeing with `DuelOdds` `rowIds.R10` (`steamDirection: "against_pick"`).

---

## Execution Rules & Token-Saving Guardrails
1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `fix/swarm-wf-1795722858714`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Reject/Recover Missing Top-Level `"picks"` Array & Block Contradictory `wageringPass: true` on Bet Recommendations

### Observed Failure (`wf-1795722858714`)
- Manager emitted `summary: "Bottom-line call: construct a 3-leg parlay with R1, R10, and R5"`, `DataTable` rows `R1, R5, R10`, `criticApproved: true`, and **no `"picks"` key**.
- Compiler post-processor defaulted `wageringPass: true` without rejecting or hydrating `picks`, and Verifier passed Attempt 1 with `rating: 0.98`.

### Search Anchors
- `"wageringPass"`, `"picks"`, `"DataTable"`, `"scorecards"`, `"Manager Node"`, `"Verification"`

### Required Changes
1. **Make Top-Level `"picks"` Unmistakable in Manager Prompt & Normalize `scorecards`:**
   - Ensure the Manager output schema places `"picks": [{ "row": "R#", "side": "...", "confidence": 0.75, "reasons": [...], "reason": "...", "reasonSource": "..." }]` prominently at top level and explicitly states: `"NEVER put picks only in components/DataTable—top-level 'picks' MUST contain every recommended wager; leave 'picks': [] ONLY when intentionally passing with wageringPass: true."`
   - Normalize `scorecards[].scorecard` -> `scorecards[].notes` if a model emits `"scorecard"` instead of `"notes"`.
2. **Deterministic Verifier Rejection for Missing/Empty `"picks"` When Prose or `DataTable` Recommends Wagers:**
   - Before approving Verification, run a deterministic schema check:
     - Detect if `compiled.picks` is missing or empty (`!Array.isArray(compiled.picks) || compiled.picks.length === 0`) while ANY of the following holds:
       - `summary` or `analysis` explicitly recommends placing wagers (`construct a ... parlay`, `place a`, `proceed with`, `selected legs`, citing board rows `R\d+`) without pass prose, OR
       - `components` contains a `DataTable` with rows containing valid board `R\d+` IDs (`R1`, `R5`, `R10`).
     - If detected, **FAIL Verification Attempt 1** (repairable feedback—do NOT add those rows to `vetoedLegs`) with:
       `"Schema violation: top-level 'picks' array is missing or empty while summary/analysis/DataTable recommend [R1, R5, R10]. Populate top-level 'picks' with exact pick objects for those rows and set wageringPass: false."`
3. **Deterministic Fallback Hydration Before Emitting Final Payload (Safety Net After Retry):**
   - If Manager still omits `picks` on final attempt while `criticApproved === true`, `DataTable` / `summary` cites valid non-vetoed board rows (`R#`), AND matching structured pick objects exist from Pass 1 specialists (`a1`/`a2`) for those exact rows:
     - Hydrate `compiled.picks` from the matching specialist pick objects for those exact rows and set `wageringPass: false`.
   - Conversely, if `compiled.picks` is genuinely empty and `wageringPass === true`, NEVER emit `summary`/`analysis`/`DataTable` telling the user to place a parlay—rewrite to clean no-bet pass prose so `wageringPass: true` and prose can never contradict each other.

### Acceptance Criteria
- Unit test (`wf-1795722858714` fixture: Manager omits `"picks"` while `summary` and `DataTable` recommend `R1, R5, R10`):
  - Deterministic Verifier rejects Attempt 1 with `"Schema violation: top-level 'picks' array is missing or empty..."` (NOT `0.98` success) and does NOT add `R1`/`R5`/`R10` to `vetoedLegs`.
  - If Manager populates `picks: [R1, R5, R10]` on Attempt 2 -> passes with `wageringPass: false` and `picks.length === 3`.
  - If Manager still omits `picks` on final attempt -> deterministic hydration recovers `[R1, R5, R10]` from `a1`'s non-vetoed picks with `wageringPass: false` (never `wageringPass: true` alongside `"construct a 3-leg parlay"`).

---

## S2: Fix `get_market_movement` Spread Steam Threshold (`>= 1.0 pt` Across NCAAF/NFL/NBA)

### Observed Failure (`wf-1795722858714`)
- `college-football-401856879`: `Open -15.5 -> Current -14.5 | Delta: 1 | ML -820 -> -670` emitted `Steam: neutral (1 pts)` instead of `TOWARD away TCU Horned Frogs (+15.5 -> +14.5, 1.0 pt) | AGAINST home Texas Tech Red Raiders (-15.5 -> -14.5)`.

### Search Anchors
- `"get_market_movement"`, `"Steam: neutral"`, `"TOWARD"`, `"AGAINST"`, `"americanfootball_ncaaf"`

### Required Changes
- Audit the spread steam threshold in `get_market_movement` across all sports (`americanfootball_nfl`, `americanfootball_ncaaf`, `basketball_nba`, `icehockey_nhl`).
- Ensure any spread move with `Math.abs(spreadDelta) >= 1.0` (and `>= 0.5` for NFL key-number moves like `-2.5 -> -3`, which already works) emits explicit directional steam (`TOWARD <side> | AGAINST <other_side>`) instead of `Steam: neutral (1 pts)`—matching `DuelOdds` `rowIds` steam classification so proposers and Critic see `AGAINST Texas Tech Red Raiders` accurately.

### Acceptance Criteria
- Unit test (`college-football-401856879`, `Open home -15.5 -> Current -14.5`, `Delta: 1`): Emits `Steam: TOWARD away TCU Horned Frogs (+15.5 -> +14.5, 1.0 pt) | AGAINST home Texas Tech Red Raiders (-15.5 -> -14.5)` (NOT `Steam: neutral (1 pts)`).

---

## Verification Commands
```powershell
npx tsc --noEmit
npx vitest run
```