# Engineering Fix Spec — `The_Perfect_Swarm` (`wf-1795638625511`: Contra-Steam & Split-Seat Guard, 30s Latency Trim, Partial-Log Injury Weighting)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits and zero SQL migrations.
**Baseline:** Cross-sport `row_side_mismatch` (`R4` Wild + `R104` Timberwolves), Verifier token scoping (`2,837` tokens), and `diagnostics` telemetry are verified live. Do NOT re-audit them.
**Observed Issues (`wf-1795638625511` + `player_game_logs` Audit):**
1. **Contra-steam & split-seat leak:** On `nba-401909320`, `get_market_movement` showed sharp steam `AGAINST away Minnesota Timberwolves ML (-102 -> +112, +3.3pp toward OKC)`, and `a1` backed **OKC (`R20`)** while `a2` backed **MIN (`R104`)**—yet `R104` passed Risk Critic and Manager published `"Majority Consensus support this pairing"`.
2. **~31s avoidable latency:** `a1` (`nvidia/nemotron-3-ultra-550b`) timed out after `28,097ms` before failing over to `gemini-3.5-flash-lite` (which answered the exact same 8,165-token prompt in **`1.96s`**), and `critic (Verification)` still hit `gemini-3.1-flash-lite` (`503`, `3,001ms`) before succeeding on Cloudflare in `3.1s`.
3. **Overly strict `>= 3` dates injury gate:** `player_game_logs` has 332 valid rows (`1` boxscore date per logged player + depth charts), yet requiring `>= 3` distinct `game_date`s per team kept `19/20` games on `[unweighted_fallback]` even for players who already have real Tier-1 stats.

---

## Execution Rules & Token-Saving Guardrails
1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `fix/swarm-wf-1795638625511`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Block Sharp Contra-Steam Legs in `optimal` Mode & Never Call Split-Seat Games `"Majority Consensus"`

### Observed Failure (`wf-1795638625511`)
- `nba-401909320` had `Steam: Side TOWARD home Oklahoma City Thunder ML (-116 -> -132, +3.3pp implied) | AGAINST away Minnesota Timberwolves ML (-102 -> +112)`.
- `a1` proposed `R20` (`Oklahoma City Thunder -1.5`); `a2` proposed `R104` (`ML Minnesota Timberwolves`).
- Because `a2` did not mention steam in its reason, the deterministic check skipped `R104`, and the Manager selected `R104` claiming `"Majority Consensus support this pairing"`.

### Search Anchors
- `"contra_steam_misread"`, `"=== TOP PILLAR CANDIDATES"`, `"Majority Consensus"`, `"AGAINST"`, `"Risk Critic"`

### Required Changes
1. **Penalize Sharp Contra-Steam in `=== TOP PILLAR CANDIDATES ===`:**
   - When `get_market_movement` emits `AGAINST <side>` with sharp movement (`>= 2.5pp` ML implied shift OR `>= 1.0` pt spread move), subtract `1` pillar from `<side>` (or mark `[contra_steam_risk: AGAINST <side>]` and exclude `<side>` from top 2+ pillar qualification unless `model_signal` explicitly favors `<side>`).
2. **Add Deterministic Sharp Contra-Steam Guard for `optimal` Parlays:**
   - In Risk Critic pre-check (for `riskProfile === "optimal"` / `allowParlay === true`), flag `"sharp_contra_steam"` on any proposed leg where `get_market_movement` reports `AGAINST <picked side>` (`>= 2.5pp` ML or `>= 1.0` pt spread) AND `model_signal` does NOT favor the picked side—vetoing that leg (or requiring the Manager to pick an unconflicted alternative like `R2` `NYI ML` instead).
3. **Prevent False `"Majority Consensus"` on Opposing-Side Splits:**
   - Detect when `a1` and `a2` propose **opposite sides of the same `event_id`** (e.g., `a1` -> `R20` OKC, `a2` -> `R104` MIN).
   - Tag that game `"seat_conflict"` in the Manager synthesis context so the Manager cannot describe a split game as `"Majority Consensus"` and prefers unconflicted legs agreed upon or unopposed by the other proposer.

### Acceptance Criteria
- Unit test (`nba-401909320`: `AGAINST away Minnesota Timberwolves ML +3.3pp`, `model_signal` absent):
  - `TOP PILLAR CANDIDATES` does NOT rank Minnesota Timberwolves as a clean 2-pillar side.
  - Deterministic Risk Critic check flags `"sharp_contra_steam"` on `R104` (`ML Minnesota Timberwolves`).
- Unit test (split seats: `a1` picks `R20` OKC, `a2` picks `R104` MIN): Synthesis context marks `nba-401909320` as `seat_conflict` (never `Majority Consensus`).

---

## S2: Cut `a1` NVIDIA Timeout (`28s` -> `15s`) & Route Verifier Directly Past `gemini-3.1-flash-lite`

### Observed Timings (`wf-1795638625511`)
- `a1` waited `28,097ms` for NVIDIA to time out, then `gemini-3.5-flash-lite` completed the `8,165`-token `Quant Proposer` call in `1.96s` (`30,057ms` total).
- `critic (Verification)` tried `gemini-3.1-flash-lite` first, burned `3,001ms` on a `503`, then finished on Cloudflare in `3.1s`.

### Search Anchors
- `"28000"`, `"NVIDIA request timed out"`, `"gemini-3.1-flash-lite"`, `"Verifier"`, `"Critic verification"`

### Required Changes
1. **Tighten `a1` NVIDIA Timeout to `15,000ms`:**
   - Reduce `a1`'s single-attempt NVIDIA timeout from `28,000ms` to `15,000ms` so healthy fast NVIDIA responses (`6–14s`) still win while stalled calls immediately fail over to `gemini-3.5-flash-lite` (`~2s`)—saving ~13s on every NVIDIA stall.
2. **Route Verifier Directly to `gemini-3.5-flash-lite -> cloudflare` (Skip `3.1-flash-lite` First-Try):**
   - Inspect why `critic (Verification)` still tried `gemini-3.1-flash-lite` first on `wf-1795638625511`.
   - Set Verifier's primary order to `gemini-3.5-flash-lite -> cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast -> groq/openai/gpt-oss-20b` (skipping `gemini-3.1-flash-lite` when Manager already saw a `503` on Gemini, or keeping `3.5-flash-lite` first when Gemini is healthy).

### Acceptance Criteria
- Unit test (`a1` NVIDIA timeout): Timeout fires at `15,000ms` (not `28,000ms`) and fails over to `gemini-3.5-flash-lite`.
- Unit test (Verifier routing): Verifier never calls `gemini-3.1-flash-lite` before `gemini-3.5-flash-lite` or `cloudflare`.

---

## S3: Allow Per-Player Tier Weighting With Neutral `1.0` Unlogged Floor (Fix `1/20 weighted` Bottleneck)

### Confirmed DB State (`2026-11-25 18:00 UTC`)
- `public.player_game_logs` now has `332` rows (`75` NBA + `3` depthchart, `133` NFL, `114` NHL + `7` depthchart) — currently `1` game date per logged player.
- Because S2 required `>= 3` distinct `game_date`s per team before enabling weighted summaries, `19/20` games stayed `[unweighted_fallback]`.

### Search Anchors
- `"get_injury_and_roster_delta"`, `"unweighted_fallback"`, `"depth"`, `"nhl_club_stats"`, `"espn_season_stats"`, `"espn_depthchart"`

### Required Changes
- In `get_injury_and_roster_delta`:
  - Keep the **no-artificial-bias** rule: NEVER downgrade an unlogged player to `0.5 depth` unless their team has `>= 5` distinct logged `game_date`s OR a confirmed `depth_rank >= 3` from depth charts. On `< 5`-date teams, score unlogged `OUT` players at neutral `1.0` (`unlogged`) on **both** sides.
  - Lower the activation gate for weighted impact summaries from `>= 3` dates per team to: **enable weighted `[impact X.X]` whenever `>= 1` injured player in the game has a real logged row (`espn_boxscore`, `espn_depthchart`, `nhl_club_stats`, or `espn_season_stats`)**—because unlogged players stay at neutral `1.0` on both sides, logged Tier-1 stars (`3.0`/`4.0`/`5.0`) and Tier-1 `Q` guards activate immediately with zero `0.5` vs `1.0` scale bias.
  - Label partial-coverage weighted summaries transparently (e.g., `[impact 5.0: 1 Tier-1, 2 unlogged]` without calling unlogged players `depth`).

### Acceptance Criteria
- Unit test (1 boxscore date + 1 logged Tier-1 star + 2 unlogged `OUT` on Team A vs 3 unlogged `OUT` on Team B):
  - Team A scores `3.0 + 1.0 + 1.0 = 5.0` (`1 Tier-1, 2 unlogged`), Team B scores `3.0` (`3 unlogged`) -> zero `0.5` bias, activates weighted summary immediately without needing 3 dates.
- Unit test (0 logged injured players on both teams): Still falls back cleanly to `[unweighted_fallback]`.

---

## Verification Commands
```powershell
npx tsc --noEmit
npx vitest run
```