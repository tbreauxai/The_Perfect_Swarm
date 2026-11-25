# Engineering Fix Spec — `The_Perfect_Swarm` (`wf-1795631514400`: `model_signal` Guard, Injury Scale Parity, `a1`/Gemini Latency & Inline Diagnostics)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits and zero SQL migrations.
**Baseline:** Groq TPM fixes worked live (`Risk Critic: 1.3s`, `Verifier: 5.0s`), false `row_side_mismatch` is fixed, and `player_game_logs` weighted tiers are active. Do NOT re-audit them.
**Observed Issues (`wf-1795631514400`):**
1. `a1` hallucinated `model_signal=lean_home` on `R95` (`nhl-401892792`, which has NO `model_signal` tag) and `CAR @ TBL` (`model_signal=neutral`), and it passed verification at `0.98`.
2. Weighted injury scoring mixed `0.5/player` (logged team) against `1.0/player` (unlogged team) in the same game (`OKC 7 OUT = 7.0` vs `MIN 3 OUT = 1.5`; `PIT 4 OUT = 4.0` vs `CGY 3 OUT = 1.5`) and labeled unlogged stars (`Curry`, `Edwards`, `Holmgren`, `Barkov`, `Adams`) as `"depth"`.
3. `Quant Proposer` (`a1`, NVIDIA 550B) took `53.9s` (~45% of total runtime), and `Manager` spent `14s` failing over 3 Gemini models (`3.5-flash-lite -> 3.1-flash-lite -> 3.8-flash`) with the exact HTTP error hidden inside truncated SSE events.
4. Cloudflare Llama emitted nested `scorecards` (`{ seat, scorecard: { approve, veto } }`) instead of flat `{ seat, verdict, notes }`.

---

## Execution Rules & Token-Saving Guardrails
1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `fix/swarm-wf-1795631514400`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Deterministic `model_signal_misread` Guard & Normalize Nested `scorecards[]`

### Observed Failures (`wf-1795631514400`)
- `nhl-401892792` (`Montreal Canadiens @ Colorado Avalanche`) had NO `model_signal` tag on `COMPACT SLATE`, yet `a1` and the Manager published `"R95 satisfies all three pillars (form, model_signal, health)"` with `"model_signal lean_home"` and passed at `rating: 0.98`.
- `scorecards[]` emitted `{ "seat": "Risk Critic", "scorecard": { "approve": "R2 and R95", "veto": "" } }` instead of `{ "seat": "Risk Critic", "verdict": "approve", "notes": "..." }`.

### Search Anchors
- `"model_signal"`, `"contra_steam_misread"`, `"symmetric_injury_misread"`, `"scorecards"`, `"verdict"`

### Required Changes
1. **Add Deterministic `model_signal_misread` Check (Risk Critic Pre-Check + Verifier):**
   - Parse each game's actual `model_signal` from `COMPACT SLATE` (`lean_home`, `lean_away`, `neutral`, or `none` when omitted).
   - If any pick's `reason`, `reasons[]`, or the seat's per-pick `analysis` claims `model_signal` / `lean_home` / `lean_away` support for a game whose slate tag is `none`, `neutral`, or leans the **opposite** direction, flag `"model_signal_misread"` and veto that claim/leg (or strip the false `model_signal` pillar before approval).
2. **Normalize Nested `scorecards[]` in Compiler Post-Processor:**
   - If the Manager returns `{ seat, scorecard: { approve, veto } }` (or missing `verdict`), normalize every entry to `{ seat, verdict: "approve" | "veto" | "partial", notes: "..." }` so downstream telemetry and UI always receive a consistent schema.

### Acceptance Criteria
- Unit test (`nhl-401892792` with no `model_signal` tag): Proposing `R95` with reason `"model_signal lean_home"` triggers `model_signal_misread`.
- Unit test (`nhl-401892785` with `model_signal=lean_home`): Proposing `R2` (`New York Islanders ML`) with `"model_signal lean_home"` passes cleanly.
- Unit test (scorecard normalizer): `{ seat: "Risk Critic", scorecard: { approve: "R2 and R95", veto: "" } }` normalizes to `{ seat: "Risk Critic", verdict: "approve", notes: "R2 and R95" }`.

---

## S2: Fix Mixed `0.5` vs `1.0` Injury Math & Stop Tagging Unlogged Stars as `"depth"`

### Observed Failure (`wf-1795631514400`)
- When one team had `player_game_logs` coverage and the opponent did not, unlogged `OUT` players were scored `0.5` (`depth`) on the logged team vs `1.0` (`unweighted`) on the unlogged team—producing artificial edges (`PIT 4 OUT = 4.0` vs `CGY 3 OUT = 1.5` -> fake `+2.5`; `OKC 7 OUT = 7.0` vs `MIN 3 OUT = 1.5` -> fake `+5.5`) and labeling `Stephen Curry`, `Anthony Edwards`, `Chet Holmgren`, `Aleksander Barkov`, and `Davante Adams` as `"depth"`.

### Search Anchors
- `"get_injury_and_roster_delta"`, `"unweighted_fallback"`, `"impact"`, `"depth"`, `"player_game_logs"`

### Required Changes
1. **Require Both-Team Coverage Parity Before Comparing Weighted Totals:**
   - Never compare weighted `0.5`-floor totals on Team A against unweighted `1.0` defaults on Team B.
   - Only classify `Health Balance` using weighted `[impact X.X]` edges when **both** teams (or every team with `>= 1` injured player) have `>= 3` distinct `game_date`s (or `espn_depthchart` / `season_stats` rows) in `player_game_logs`. Otherwise stay on consistent `[unweighted_fallback]` (`1.0` per player on both sides) so neither side gets a 2× unit bias.
2. **Stop Labeling Unlogged Players as `"depth"` Without Proof:**
   - Only assign `0.5` (`depth`) when a player has actual logged low-usage games (e.g., NBA `< 15` MPG, NHL `< 12` TOI) OR a confirmed `depth_rank >= 3` from depth charts OR their team has `>= 5` distinct logged `game_date`s across the last 14 days proving they are genuinely unused/inactive depth.
   - If a player has `0` rows on a thinly logged team (`< 5` dates), label them `unlogged` at neutral weight `1.0` (never `"depth"`).
3. **Recognize `source: "season_stats"` Rows From `player_game_logs`:**
   - Support season-average rows (`source: "nhl_club_stats" | "espn_season_stats" | "espn_depthchart"`) in `get_injury_and_roster_delta` so multi-week injured stars (`Curry`, `Edwards`, `MacKinnon`, `Barkov`) resolve directly to Tier 1 (`3.0`–`5.0`).

### Acceptance Criteria
- Unit test (mixed coverage): Team A has 1 logged game (`3 OUT`, all unlogged) and Team B has 0 logged games (`4 OUT`, all unlogged) -> stays `[unweighted_fallback]` (`3 vs 4` = `symmetric`), NEVER `1.5 vs 4.0` (`+2.5` fake edge).
- Unit test (season-stats star): `Stephen Curry` with `source: "espn_season_stats"` (`minutes: 33.2, points: 26.4`) scores Tier 1 (`3.0`), never `"depth"`.

---

## S3: Cut `a1` (`53.9s`) & Gemini 3-Hop (`14s`) Latency Waste

### Observed Timings (`wf-1795631514400`)
- `Quant Proposer` (`a1`, `nvidia/nemotron-3-ultra-550b`) took `53.9s` (almost 5× slower than `a2`'s `11.8s`).
- `Manager` spent `14s` trying 3 Gemini models sequentially (`3.5-flash-lite -> 3.1-flash-lite -> 3.8-flash`) before succeeding on Cloudflare.

### Search Anchors
- `"nemotron"`, `"Quant Proposer"`, `"gemini-3.5-flash-lite"`, `"Failover"`, `"timeout"`

### Required Changes
1. **Abort Gemini Sibling Loop Immediately on Auth / Invalid-Key / Project-Wide Errors:**
   - When the primary Gemini model fails with HTTP `400` (bad request/invalid param), `401`/`403` (auth/key/billing), or a project-wide `429` (`limit: 0` / daily quota exhausted), do **NOT** burn 10+ seconds retrying 2 more Gemini siblings—immediately mark Gemini on cooldown and jump straight to the next external provider (`Cloudflare` / `Mistral`).
   - Only try Gemini siblings (`3.5-flash-lite -> 3.1-flash-lite -> 3.8-flash`) on model-specific `503` / `404` / per-model RPM `429`.
2. **Bound `a1` (`NVIDIA` 550B) Latency:**
   - Cap `a1`'s reasoning/completion budget (e.g., `max_tokens <= 1800` and low thinking effort / non-verbose reasoning parameter if supported by the NVIDIA adapter) and set a `30s` single-attempt timeout on `a1` so if NVIDIA stalls past 30s on a heavy slate, it fails over cleanly to fast `Groq` (`1–3s`) or `Mistral` instead of blocking the entire run for 54s+.

### Acceptance Criteria
- Unit test (Gemini fast-abort): Primary Gemini returning `400` or `403` skips remaining Gemini siblings and jumps straight to Cloudflare in 1 hop.
- Unit test (Gemini `503`): Primary Gemini returning `503` still tries sibling `gemini-3.1-flash-lite` before leaving Gemini.
- Unit test (`a1` timeout): `a1` exceeding `30s` aborts and fails over cleanly instead of stalling 54s+.

---

## S4 (Debugging Upgrade): Emit Compact `diagnostics` Block Directly on `rawFinalAnalysisPayload`

### Observed Debugging Pain Point
- Every 20-game Flight Recorder brief truncates `llmAndToolEvents` at `~350–400 KB`, hiding per-seat durations and exact Gemini/provider failover HTTP errors unless we run manual SQL queries.

### Search Anchors
- `"rawFinalAnalysisPayload"`, `"verification"`, `"tools_called"`, `"Failover"`

### Required Changes
- Attach a compact, bounded (`< 2 KB`) `diagnostics` object to `rawFinalAnalysisPayload` (and to `run_timeout` error payloads):
  ```json
  "diagnostics": {
    "totalMs": 62400,
    "hop1ToolsMs": 4120,
    "seatTimings": [
      { "seat": "a1", "role": "Quant Proposer", "provider": "nvidia", "model": "...", "durationMs": 22100, "inputTokens": 8150, "status": "ok" }
    ],
    "failovers": [
      { "seat": "manager", "from": "gemini/gemini-3.5-flash-lite", "to": "cloudflare/...", "status": 404, "error": "models/gemini-3.5-flash-lite is not found...", "durationMs": 410 }
    ]
  }
  ```
- Redact any keys/tokens and cap each `error` string to `160` chars so it is always safe and tiny.

### Acceptance Criteria
- Unit test: Final payload includes `diagnostics.seatTimings` and `diagnostics.failovers` with exact HTTP status + error snippet whenever any failover occurs.

---

## Verification Commands
```powershell
npx tsc --noEmit
npx vitest run
```