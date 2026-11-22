# Engineering Spec (Parts 7 + 8) — `The_Perfect_Swarm` (Standalone)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits and zero Supabase SQL migrations required.
**Compatibility:** All changes below are backward-compatible with live `DuelOdds`.

## Execution Rules & Guardrails
1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `fix/swarm-part7-8`), NOT `main`.
3. **Grep Before Editing:** Use the exact **Search Anchors** under each task; read only the matched files to conserve tokens.
4. **Do NOT Touch Qdrant:** Leave Qdrant collection settings (`pwa_swarm_dev_cortex_v3`) untouched.

---

## S1: Fix Compiler `summary` Splitting Mid-Name on `"St."` (Part 7 / P1-1)

### Observed Failure (`wf-1795376977763`)
- `rawFinalAnalysisPayload.summary` truncated to: `"Bottom-line call: utilize a 2-leg parlay consisting of St."` because the first-sentence extractor split on the period after `"St."`.

### Search Anchors
- `"Bottom-line call:"`, `summary`, `match(/^[^.!?]+[.!?]/)`, `split(/(?<=[.!?])\s+/)`

### Required Changes
- Replace naive period splitting in the Compiler `summary` extractor with an abbreviation-safe sentence splitter that ignores:
  - Sports/city/name abbreviations: `St.`, `Ft.`, `Mt.`, `Jr.`, `Sr.`, `Dr.`, `vs.`, `No.` (case-insensitive)
  - Decimal numbers / spreads / totals: `-10.5`, `+3.5`, `46.5`, `0.85`
  - Single-letter initials: `A.J.`, `P.J.`, `D.J.`, `T.J.`, `B.J.`
- Preserve the complete first sentence (up to ~`220` chars) without truncating mid-team-name.

### Acceptance Criteria
- Unit test: `"Bottom-line call: utilize a 2-leg parlay consisting of St. Louis Blues ML (R63) and Denver Nuggets -10.5 (R44). The consensus..."` returns the full first sentence ending at `(R44).`.
- Unit test: Preserves `"Mt. St. Mary's"`, `"P.J. Washington"`, `"vs."`, and `"-10.5"` cleanly.

---

## S2: Scope Groq `Risk Critic` Strictly to Proposed Pick `eventId`s (Part 7 / P1-2)

### Observed Failure (`wf-1795376977763`)
- Proposers (`a1`, `a2`) proposed picks across only **3 games** (`nba-401910033`, `nhl-401892770`, `nba-401910032`), yet Critic `coveredEventIds` padded an unproposed 4th game (`nfl-401873075`), pushing `nba-401910032` (Denver Nuggets) past the 1,500-token cap (`dossierSectionsIncluded: 3`, `dossierTruncated: true`).

### Search Anchors
- `"dossierTruncated"`, `"dossierSectionsIncluded"`, `"coveredEventIds"`, `"Risk Critic"`, `"Game Slate:"`

### Required Changes
1. When `a1` and/or `a2` propose `>= 1` pick, build Critic `coveredEventIds` strictly from the deduplicated `eventId`s of those proposed picks (never pad with unproposed games).
2. Fall back to padding with top-pillar games ONLY when **zero** picks were proposed across all proposer seats.
3. Order Critic dossier sections strictly by proposed-pick `eventId`s and compact verbose player-by-player lines beyond the `Summary:` line only if needed so `<= 4` proposed games always fit with `dossierTruncated: false`.

### Acceptance Criteria
- Unit test (`a1` proposes `R63`, `R44`, `R87`; `a2` proposes `R63`, `R67`): Critic `coveredEventIds` is exactly `["nba-401910033", "nhl-401892770", "nba-401910032"]` (no `nfl-401873075`), `dossierSectionsIncluded === 3`, and `dossierTruncated === false`.

---

## S3: Starter-Weighted Injury Impact Scoring & Risk Critic Alignment (Part 8 / P0-2)

### Observed Failure (`wf-1795376977763`)
- Raw injury headcounts labeled `Utah Jazz (3 OUT: Markkanen, Jaren Jackson Jr., Nurkic)` healthier (`home_advantage`) than `Dallas Mavericks (5 OUT: Lively II, P.J. Washington + 3 end-of-bench depth)`, causing the Risk Critic to falsely veto Dallas ML even as FanDuel steamed Dallas `-120 -> -134`.

### Search Anchors
- `"Health Balance:"`, `"get_injury_and_roster_delta"`, `"home_advantage"`, `"away_advantage"`, `"uncertain_questionable"`, `"symmetric_injury_misread"`

### Required Changes
1. **Compute Lightweight Player Impact Tiers Using Existing Free Supabase Data (Zero New APIs / Zero SQL Migrations):**
   - Inside the `get_injury_and_roster_delta` handler/formatter in `The_Perfect_Swarm`, enrich the returned `OUT`/`QUESTIONABLE` players by querying the existing Supabase `player_game_logs` (or existing player/roster metadata already accessible via the service-role client) in a single batched query per run (with graceful fallback when a league like NCAAF has no logs):
     - **Tier 1 — Core / High-Impact:**
       - NFL Starting QB (`QB1` / top team passer by recent attempts): weight `5.0`
       - NHL Starting Goaltender (`G` with highest recent starts/TOI): weight `4.0`
       - NBA top-3 rotation/usage (`>= 28` MPG or `>= 15` PPG), NHL top-6 F / top-pair D (`>= 18` TOI or top-4 points), NFL primary skill starter: weight `3.0`
     - **Tier 2 — Rotation / Starter (`1.5`):** NBA `15-27` MPG; NHL `12-17` TOI; NFL regular contributor.
     - **Tier 3 — Depth / Bench / Unlogged (`0.5`):** `< 12` MPG / `< 10` TOI or zero recent game-log appearances (use flat `1.0` fallback ONLY when the entire team has zero `player_game_logs` rows).
   - Weight `QUESTIONABLE` at `0.5x` the player's tier weight and track `tier1QuestionablePlayers[]`.
2. **Upgrade `Health Balance` Summary & Classification:**
   - Emit both raw counts AND weighted `OUT` impact in the summary header:
     ```text
     Summary: Utah Jazz (3 OUT [impact 9.0: Lauri Markkanen, Jaren Jackson Jr., Jusuf Nurkic], 0 Q) vs Dallas Mavericks (5 OUT [impact 4.5: Dereck Lively II, P.J. Washington + 3 depth], 0 Q) | Health Balance: away_advantage (Dallas Mavericks, +4.5 impact edge)
     ```
   - Grant `home_advantage` / `away_advantage` ONLY when:
     - Weighted `OUT` impact gap is `>= 2.5` points in favor of the healthier side, AND
     - The healthier side has **zero Tier-1 `QUESTIONABLE` stars**, AND
     - The healthier side stays under existing sport `Q` caps (`< 2 Q` NBA/NHL, `< 3 Q` NFL/NCAAF).
   - If the nominally healthier side has any Tier-1 `QUESTIONABLE` star (QB1, starting goalie, 28+ MPG NBA star), emit `Health Balance: uncertain_questionable (<Team>: Tier-1 Q <PlayerName>)` even if total `Q` count is `1`.
   - Keep `conditional_home_advantage` / `conditional_away_advantage` when the opponent's weighted `OUT` impact gap is `>= 6.0` despite non-Tier-1 `Q` tags on the healthier side.
3. **Align Risk Critic `symmetric_injury_misread` Check:**
   - Ensure the deterministic Critic pre-check evaluates `symmetric_injury_misread` strictly against the updated weighted `Health Balance` label.

### Acceptance Criteria
- Unit test (`nba-401910033` fixture: Utah 3 Tier-1 OUT = `9.0` vs Dallas 2 Tier-2 + 3 Tier-3 OUT = `4.5`): classifies `Health Balance: away_advantage (Dallas Mavericks)` and does NOT trigger `symmetric_injury_misread` on a Dallas pick.
- Unit test: A single `QUESTIONABLE` NFL `QB1` or NHL starting goalie forces `uncertain_questionable`.
- Unit test: Empty `player_game_logs` (e.g., NCAAF) falls back gracefully without errors.

---

## S4: Tag Extended Single-Book Moves in `get_market_movement` (Part 8 / P1-2)

### Problem
- Single-book FanDuel steam confirms direction, but buying a spread *after* a `2.0+` point move often means paying the worst number after the value is gone.

### Search Anchors
- `"Steam: TOWARD"`, `"get_market_movement"`, `"Divergence: single_book"`

### Required Changes
- Keep `Steam: TOWARD <side> | AGAINST <side>` intact for directional confirmation.
- Append `[extended_move: verify remaining value]` when a single-book spread has moved `>= 2.0` points (NBA/NFL) or a moneyline has moved `>= 5.0pp` implied probability, nudging Proposers/Critic to prefer early/moderate moves (`0.5-1.5` pts / `2.5-4.5pp` ML) when two candidates are otherwise tied.

### Acceptance Criteria
- Unit test: `2.0`-pt NBA spread move (`-8.5 -> -10.5`) appends `[extended_move: verify remaining value]`; `1.0`-pt spread move or `+3.6pp` ML move does not.

---

## S5: Disable Stale Supabase On-Demand Pull in `two-hop` Mode & Fix Greedy Odds-Scrubber / Spread Parser (`wf-1795387878671`)

### Observed Failures (`wf-1795387878671`)
1. `HybridCortex` (`llmAndToolEvents[6]`) ran `[DUELODDS SUPABASE ON-DEMAND DATA PULL]` even in `two-hop` mode, injecting 3-hour-old `19:49Z` lines mislabeled `| LIVE` (`Total=6.5` vs real `5.5`, `Spread=-3.5` vs real `-4.5`).
2. The specialist/digest odds-scrubber regex deleted `-100` from `H2H win 112-100` (causing a false `"ungrounded H2H"` veto on `R57`), deleted the entire `2) Denver Nuggets -9.5 (R24)` clause, and left `(, +4.1pp)`.
3. `row_side_mismatch` / `spread_value_mismatch` rejected `R24` (`SPR Denver Nuggets -9.5(-115)`) claiming it didn't match `"Denver Nuggets -9" (-9)` even though `a1` proposed `Denver Nuggets -9.5`.

### Search Anchors
- `"[DUELODDS SUPABASE ON-DEMAND DATA PULL]"`, `"Line Snapshots ("`, `"Row side mismatch"`, `"spread_value_mismatch"`, `"-100"`, `keyFindings`

### Required Changes
1. **Disable Legacy On-Demand Supabase Pull in `two-hop` Mode:**
   - When `triageMode === "two-hop"` (or `curatedDossier` is active), skip appending `[DUELODDS SUPABASE ON-DEMAND DATA PULL]` (`Recent/Matching Game Judgments` + `Line Snapshots`) inside `HybridCortex` retrieval so stale lines never contradict `COMPACT SLATE` or `get_market_movement`.
2. **Fix Greedy Odds-Scrubber Regex:**
   - NEVER match hyphenated game scores (`/\b\d{1,3}-\d{1,3}\b/`, e.g., `112-100`, `106-104`), numbered list items (`2) ...`), or decimal spreads (`-9.5`, `-10.5`).
   - Do not run destructive odds-stripping regexes across `a1`/`a2` `interimDigests` / `keyFindings` where they corrupt `R#` citations or H2H scores.
3. **Fix Decimal Spread Parsing in `row_side_mismatch`:**
   - Ensure both sides of `spread_value_mismatch` parse signed decimals with `/([+-]?\d+(?:\.\d+)?)/` (never truncating `-9.5` to `-9`), and verify no upstream sanitizer strips `.5` from `pick.side`.

### Acceptance Criteria
- Unit test: `two-hop` Cortex retrieval returns zero `[DUELODDS SUPABASE ON-DEMAND DATA PULL]` / `Line Snapshots` blocks.
- Unit test: Sanitizing `"1) STL ML (R43). 2) DEN -9.5 (R24). 3) DAL ML (R57): H2H win 112-100"` preserves `2) DEN -9.5 (R24)` and `112-100` completely intact.
- Unit test: `{ row: "R24", side: "Denver Nuggets -9.5" }` against `SPR Denver Nuggets -9.5(-115)` passes `row_side_mismatch` cleanly.

---

## S6: Stop Compiler Rule-4 Odds Echoes (`(-111 to -126)`) & Guarantee `summary` Field (`wf-1795387878671`)

### Observed Failure (`wf-1795387878671`)
- Compiler copied `(-111 to -126)` from `get_market_movement` into `picks[0].reasons[1]` and `insights[1]`, and omitted `summary`, causing `verified: false` (`attempts: 2`, `rating: 0.35`, `93.9s`) and forcing `DuelOdds` to drop the valid approved `R43` pick (`skippedReason: "unverified_response"`).

### Search Anchors
- `"verified"`, `"verification"`, `"default-insight-list"`, `"Steam: TOWARD"`, `"reasons"`

### Required Changes
1. **Sanitize Moneyline Price Parentheticals in Compiler `picks[].reasons` & `insights` Before Verification:**
   - Before scoring Rule 4 in the Verifier (and in the Compiler post-processor), strip inline moneyline move parentheticals like `(-111 to -126)` / `(-111 -> -126)` from `picks[].reasons`, `picks[].reason`, and `insights[].message` (replacing with qualitative wording like `favorable ML steam` while keeping spreads like `-9.5` and scores like `112-100` untouched).
   - Also remind the Compiler prompt: *"Never copy American odds like `(-111 to -126)` from `get_market_movement` into `reasons`, `insights`, or `analysis` — describe steam qualitatively (e.g., 'favorable ML steam')."*
2. **Always Populate `summary`:**
   - If the Compiler JSON omits `summary` (as happened on Attempt 2), deterministically populate `summary` from the first abbreviation-safe sentence of `analysis` (using S1's splitter) before returning.

### Acceptance Criteria
- Unit test: Compiler output containing `"Steam TOWARD STL ML (-111 to -126)"` and no `summary` is normalized to remove `(-111 to -126)`, populates `summary` cleanly, and passes Rule 4 verification on Attempt 1.

---

## Verification Commands (`The_Perfect_Swarm`)
```powershell
npx tsc --noEmit
npx vitest run
```