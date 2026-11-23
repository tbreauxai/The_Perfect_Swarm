# Engineering Fix Spec — `The_Perfect_Swarm` (`wf-1795394398351`)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits and zero SQL migrations.
**Baseline:** All prior Part 7/8 fixes (sentence splitter, Critic scoping, split Side/Total steam, Hop-1 `4000ms` timeout & concurrency cap, verifier corpus & veto-leakage overrides, indoor weather skip) are already merged and verified live. Do NOT re-audit them.
**Scope of This Spec:** Fixes the 3 net-new issues observed in `wf-1795394398351`:
1. Post-prune veto prose cleaner chopped sentences mid-clause (`"Bottom-line call: pass. which invalidated..."`, lowercase `"the Risk Critic..."`) and cleared `scorecards` to `[]`.
2. `Quant Proposer` (`a1`) still claimed an asymmetric health edge on `uncertain_questionable` games (`BOS 3 Q`, `NYK 3 Q`), triggering a full Critic veto and a 108.3s 2-attempt retry loop.
3. `get_injury_and_roster_delta` silently stamped flat `impact_tier: 2, impact_weight: 1` when `public.player_game_logs` returned `0` rows, and omitted `[impact X.X]` / fallback status from the `Summary:` line.

---

## Execution Rules & Token-Saving Guardrails
1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `fix/swarm-wf-1795394398351`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Whole-Sentence Veto Pruning & Preserve `scorecards[]` on Full-Veto Passes

### Observed Failure (`wf-1795394398351`)
- After stripping vetoed `Boston Celtics` and `New York Knicks` legs from the Manager output, `rawFinalAnalysisPayload` emitted broken prose fragments and dropped all seat scorecards:
  - `summary`: `"Bottom-line call: pass. which invalidated the proposed asymmetric injury edge."`
  - `analysis`: `"...evaluating four games for potential parlay inclusion. the Risk Critic has vetoed both selections..."`
  - `insights[0]`: `"the Risk Critic has vetoed both selections..."` (lowercase start)
  - `scorecards`: `[]`

### Search Anchors
- `"Bottom-line call: pass."`, `"default-insight-list"`, `"Synthesis Findings"`, `"scorecards"`, `"criticApproved"`, `"wageringPass"`

### Required Changes
1. **Whole-Sentence Removal Only:** When stripping a vetoed team or row recommendation from `summary`, `analysis`, or `insights`, remove the **entire sentence** (using the existing abbreviation-safe sentence boundary splitter) — never slice mid-sentence at a comma or clause.
2. **Clean Deterministic Pass Fallback When `picks.length === 0`:**
   - If post-prune cleanup removes all proposed legs (`picks.length === 0` and `criticApproved === false`), generate a clean, grammatical `summary`, `analysis`, and `insights` explaining the pass and the Critic's veto reason(s) instead of regex-patching fragments out of the rejected draft.
   - Ensure every surviving sentence and insight begins with a capitalized letter and ends with clean punctuation.
3. **Preserve `scorecards[]` on Full-Veto Passes:**
   - Never overwrite `scorecards` to `[]` when a full Critic veto occurs. Preserve the seat scorecards, ensuring `{ seat: "Risk Critic", verdict: "veto", criticApproved: false, wageringPass: true }` is explicitly present.

### Acceptance Criteria
- Unit test: Full-veto pass on `wf-1795394398351` fixture produces grammatical `summary`, `analysis`, and `insights` with zero lowercase sentence starts, zero dangling fragments like `"Bottom-line call: pass. which..."`, and a non-empty `scorecards[]` containing the Risk Critic `"veto"` entry.
- Unit test: Partial-veto cleanup (1 of 3 legs vetoed) deletes only complete sentences referencing the vetoed leg as a recommendation while keeping surviving legs intact.

---

## S2: Explicit `uncertain_questionable` Prohibition for Proposers

### Observed Failure (`wf-1795394398351`)
- `Quant Proposer` (`a1`) forced `BOS -8.5 (R14)` and `NYK -7.5 (R11)` claiming *"a clear asymmetric health edge"* even though the dossier explicitly said `Health Balance: uncertain_questionable (Boston Celtics: 3 Q)` and `uncertain_questionable (New York Knicks: 3 Q)` — walking straight into a full Critic veto and burning 108.3s across 2 attempts.

### Search Anchors
- `"uncertain_questionable"`, `"Health Balance:"`, `"symmetric_injury_misread"`, `"TOP PILLAR CANDIDATES"`

### Required Changes
1. **Proposer Prompt Calibration:** Add an explicit rule to the Swarm proposer instructions:
   - *"Never claim an injury or health advantage when `Health Balance` is `uncertain_questionable`. Treat `uncertain_questionable` as disqualifying for Pillar 3 (roster health edge)."*
2. **Deterministic Pillar Scorer Alignment:** Verify `=== TOP PILLAR CANDIDATES ===` (and any local candidate pre-ranker) strictly excludes `uncertain_questionable` games from receiving Pillar 3 credit so Proposers aren't nudged toward them on thin late slates.

### Acceptance Criteria
- Unit test: Proposer prompt contains the explicit `uncertain_questionable` prohibition, and candidate pillar scoring awards `0` health-pillar credit to `uncertain_questionable` matchups (`BOS @ GSW`, `IND @ NYK`, `MIN @ SF`).

---

## S3: Starter-Weighted Injury Impact Summary + Honest `[unweighted_fallback]` Tag

### Observed Gap (`wf-1795394398351` + DB Audit)
- Because `public.player_game_logs` currently has `0` rows (fixed separately in `DuelOdds`), `get_injury_and_roster_delta` stamped every player (`Kyler Murray`, `Mike Evans`, `Elias Pettersson`, `Thatcher Demko`, `Bo Richter`) as `impact_tier: 2, impact_weight: 1` and printed raw counts only in `Summary:` without `[impact X.X]` or any fallback indicator.

### Search Anchors
- `"impact_tier"`, `"impact_weight"`, `"player_game_logs"`, `"Health Balance:"`, `"get_injury_and_roster_delta"`

### Required Changes
1. **Align `player_game_logs` Query & Real Tier Weights:**
   - Verify the batched `public.player_game_logs` lookup matches raw ESPN numeric `player_id` (and `sport`) and reads normalized `stats` JSONB fields (`minutes` / `toi`, `points`, `pass_attempts`, `goalie_starts`, `position`).
   - When `player_game_logs` rows exist for the game/team, apply real tier weights:
     - NFL starting QB (`QB1` / top passer by `pass_attempts`): `5.0`
     - NHL starting goaltender (`G` with highest recent starts/`toi`): `4.0`
     - Tier 1 core (NBA `>= 28` MPG or `>= 15` PPG; NHL `>= 18` TOI or top-4 points; NFL primary skill starter): `3.0`
     - Tier 2 rotation (NBA `15–27` MPG; NHL `12–17` TOI; NFL regular contributor): `1.5`
     - Tier 3 depth / unlogged on a team that DOES have game-log coverage: `0.5`
     - Weight `QUESTIONABLE` players at `0.5x` their tier weight.
2. **Surface `[impact X.X]` in `Summary:` & Enforce Tier-1 `Q` Guard:**
   - When weighted logs are available, print weighted `OUT` impact directly in the `Summary:` line, e.g.:
     `Summary: Utah Jazz (3 OUT [impact 9.0], 0 Q) vs Dallas Mavericks (5 OUT [impact 4.5], 0 Q) | Health Balance: away_advantage (Dallas Mavericks, +4.5 impact edge)`
   - Classify `home_advantage` / `away_advantage` on weighted `OUT` impact gap `>= 2.5` (subject to existing sport `Q` caps), and force `uncertain_questionable (<Team>: Tier-1 Q <PlayerName>)` whenever any Tier-1 star (`QB1`, starting goalie, `28+` MPG NBA star) is `QUESTIONABLE`.
3. **Honest Fallback Tag When `player_game_logs` Is Empty:**
   - When `player_game_logs` returns `0` rows for a game, append `[unweighted_fallback]` to `Health Balance` (and set `impact_tier: null` or `"unweighted"` rather than pretending every player is verified `impact_tier: 2`).

### Acceptance Criteria
- Unit test (populated logs): Utah missing 3 Tier-1 players (`9.0`) vs Dallas missing 2 Tier-2 + 3 Tier-3 (`4.5`) prints `[impact 9.0]` / `[impact 4.5]` and classifies `away_advantage (Dallas Mavericks, +4.5 impact edge)`.
- Unit test (Tier-1 `Q`): Single `QUESTIONABLE` NFL `QB1` or NHL starting goalie forces `uncertain_questionable`.
- Unit test (empty logs): `0` rows from `player_game_logs` falls back cleanly and appends `[unweighted_fallback]` to `Health Balance`.

---

## Verification Commands
```powershell
npx tsc --noEmit
npx vitest run
```