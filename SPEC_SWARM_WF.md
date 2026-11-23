# Engineering Fix Spec — `The_Perfect_Swarm` (`wf-1795446433463`)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits and zero SQL migrations.
**Baseline:** Hop-1 `4000ms` timeout/concurrency, Groq Critic scoping, split Side/Total steam, indoor weather skip, and `[unweighted_fallback]` tags are all verified live. Do NOT re-audit them.
**Triggering Incident (`wf-1795446433463`):** On a 17-game slate, `Quant Proposer` (`a1`) proposed `LAL -13.5 (R36)`, `HOU -12.5 (R32)`, and `MIN -12.5 (R13)`, claiming `"Each leg satisfies form/diff edge + asymmetric health (2 pillars)"` even though Minnesota's dossier showed `Health Balance: away_advantage (Brooklyn Nets)` with Anthony Edwards `OUT`. Because the initial Risk Critic pre-check missed `MIN -12.5`, the Manager wasted 2 full verification retries (`196.6s`) — failing Attempt 1 on a rounded `"115 PPG"` claim and Attempt 2 on `MIN -12.5` — before the `_repaired: true` fallback cleared `picks: []` while leaving `"Proceed with a 3-leg spread parlay..."` and `"between -110 and -118"` in `summary`/`analysis`.

---

## Execution Rules & Token-Saving Guardrails
1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `fix/swarm-wf-1795446433463`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Catch `symmetric_injury_misread` Across Proposer `analysis` & Blanket Pillar Claims (Before Manager Attempt 1)

### Observed Failure (`wf-1795446433463`)
- `a1` proposed `R13` (`Minnesota Timberwolves -12.5`) where `get_injury_and_roster_delta` returned `Health Balance: away_advantage (Brooklyn Nets)` (`MIN 3 OUT` incl. Anthony Edwards vs `BKN 1 OUT, 1 Q`).
- In `a1`'s `analysis`, it wrote `"Each leg satisfies form/diff edge + asymmetric health (2 pillars)"`, yet the initial Risk Critic pre-check only inspected per-pick `reason`/`reasons` (or missed blanket multi-leg claims) and returned `"All proposed legs meet criteria; no fatal injuries or rule violations"` (`anomalies: []`).
- Catching `R13` at the initial Critic gate lets the Manager immediately build a clean 2-leg parlay (`R36` + `R32`) on Attempt 1 instead of burning ~100s on failed verification retries.

### Search Anchors
- `"symmetric_injury_misread"`, `"Veto (GROUNDING):"`, `"Veto (PREMISE):"`, `"Health Balance:"`, `"All proposed legs meet criteria"`

### Required Changes
1. **Scan Both Per-Pick Rationales AND Seat-Level `analysis` in Deterministic Pre-Check:**
   - For every proposed pick `{ row, side }`, resolve whether the picked side is on the **disadvantaged** side of `Health Balance` (e.g., picking `home` when `Health Balance` is `away_advantage`, or picking `away` when `Health Balance` is `home_advantage`) or is `symmetric` / `uncertain_questionable`.
   - Trigger a **per-leg** `symmetric_injury_misread` veto on that specific leg if EITHER:
     - That pick's `reason` or `reasons[]` claims an injury/health edge, OR
     - The seat's `analysis` makes a blanket claim covering all legs (e.g., `"each leg satisfies ... health"`, `"all three ... asymmetric health"`, `"2 pillars"` when spread steam is `neutral` so health is implicitly counted as Pillar 2).
2. **Keep the Veto Scoped to the Offending Leg (`R13`):**
   - Flag ONLY `R13` (`Minnesota Timberwolves -12.5`) as vetoed so the surviving clean legs (`R36` Lakers `-13.5`, `R32` Rockets `-12.5`) pass straight through to the Manager without nuking the entire slate.

### Acceptance Criteria
- Unit test on `wf-1795446433463` fixture (`a1` proposes `[R36, R32, R13]` with `analysis` stating `"Each leg satisfies form/diff edge + asymmetric health (2 pillars)"`, where `MIN` has `Health Balance: away_advantage (Brooklyn Nets)`):
  - Deterministic pre-check flags `symmetric_injury_misread` specifically on `R13`.
  - `R36` and `R32` remain unvetoed and approved.

---

## S2: Repair `_repaired: true` Fallback Hygiene & Scrub Non-Parenthetical Odds Ranges

### Observed Failure (`wf-1795446433463`)
- When Attempt 2 exhausted retries (`RLAIF 35%`), the `_repaired: true` fallback emitted an internally contradictory payload:
  - `picks: []`, `components: []`, and omitted `criticApproved`, `wageringPass`, and `scorecards` completely (`undefined` -> Section 1 logged `criticApproved: null`, `wageringPass: false`).
  - Meanwhile `summary` and `analysis` still said: `"[UNVERIFIED] Proceed with a 3-leg spread parlay: LAL -13.5 (R36), HOU -12.5 (R32), MIN -12.5 (R13)... Risk Critic approved all three... all spreads between -110 and -118."`
- Also leaked non-parenthetical American odds (`"between -110 and -118"`) into final prose (violating Rule 4).

### Search Anchors
- `"_repaired"`, `"[UNVERIFIED]"`, `"Exhausted 2 retries"`, `"criticApproved"`, `"wageringPass"`, `"between -110"`

### Required Changes
1. **Surgical Leg-Prune Rescue Before Giving Up (When Only Specific Leg(s) Failed Verification):**
   - If the Verifier rejects specific named leg(s) (e.g., `MIN -12.5` / `R13`) on the final retry while `>= 1` other leg in `picks[]` had zero Critic or Verifier violations (`R36`, `R32`), deterministically prune only the rejected leg(s), re-sync `summary`/`analysis`/`components` to the surviving leg(s), and emit `picks: [survivingLegs]` only if deterministic checks pass; otherwise fall through cleanly to the pass fallback below.
2. **Consistent `_repaired: true` Pass Fallback (Zero Contradictory Recommendations):**
   - Whenever `_repaired: true` outputs `picks: []`, NEVER leave `"Proceed with a N-leg parlay..."` or `"Risk Critic approved all three..."` in `summary` or `analysis`.
   - Always emit explicit top-level booleans and scorecards:
     - `criticApproved: false`
     - `wageringPass: true`
     - `picks: []`
     - `scorecards`: preserve seat scorecards with `{ seat: "Risk Critic", verdict: "veto", criticApproved: false, wageringPass: true }`
     - `summary` & `analysis`: clean deterministic pass message summarizing the verification failure reason(s) (`verification.reasons`).
3. **Scrub Non-Parenthetical American Odds Ranges in Final Compiler Output:**
   - Extend the Compiler Rule-4 odds sanitizer (on `summary`, `analysis`, `picks[].reasons`, `insights`) to also strip non-parenthetical American price ranges like `"between -110 and -118"`, `"-110 to -118"`, or `"priced at -114"` (while continuing to preserve policy phrases in specialist digests like `"-220 to +150"` only inside prompts, and never touching spreads like `-12.5` or H2H scores like `121-107`).

### Acceptance Criteria
- Unit test (`_repaired: true` with `picks: []`): Output has `criticApproved === false`, `wageringPass === true`, non-empty `scorecards` with Risk Critic `"veto"`, and `summary`/`analysis` stating a pass (zero `"Proceed with a 3-leg"` text).
- Unit test (Rule-4 sanitizer): Removes `"all spreads between -110 and -118"` while keeping `"-13.5"`, `"-12.5"`, and `"121-107"` intact.

---

## S3: Stop Manager From Inventing Rounded PPG Averages (`"115 PPG"`)

### Observed Failure (`wf-1795446433463`)
- Attempt 1 failed verification (`Verification FAILED on attempt 1`) solely because the Manager rounded/invented `"115 PPG"` in prose instead of citing exact `PF/PA` values from `get_matchup_fundamentals` (burning an entire extra Manager + Verifier cycle).

### Search Anchors
- `"Ungrounded form/score claim"`, `"PF/PA"`, `"GodView Compiler"`, `"Manager Node"`

### Required Changes
1. **Tighten Manager / Compiler Prompt Instruction:**
   - Add one explicit line to the Manager synthesis prompt: *"NEVER round or estimate PPG / scoring averages (e.g., '115 PPG'). Either cite exact `PF/PA` numbers verbatim from `get_matchup_fundamentals` (e.g., '119.8 PF/G') or describe offense/defense qualitatively without numeric PPG claims."*
2. **Deterministic Verifier Alignment:**
   - Confirm the deterministic grounding check accepts exact `PF` / `PA` decimals from `get_matchup_fundamentals` (including `119.8`, `113.0` / `113`) so verbatim tool citations never false-fail.

### Acceptance Criteria
- Unit test: Manager prompt includes the no-rounded-PPG rule; verbatim `PF/PA` values (`119.8`, `113`) from `get_matchup_fundamentals` pass deterministic grounding cleanly.

---

## Verification Commands
```powershell
npx tsc --noEmit
npx vitest run
```