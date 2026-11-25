# Final Polish Engineering Spec — `The_Perfect_Swarm` (1-Game Fill-In Star Guard, Unlogged `0.5` Leak Fix & `summary` Pick Count Sync)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits and zero SQL migrations.
**Baseline:** `52.3s` 20-game runtime, `11/20` weighted injuries, venue-mismatch fix, `Tier-1 Q` calibration, and Attempt-1 `0.98` verification are verified live in `wf-1795647813045`. Do NOT re-audit them.
**Remaining Edge Cases (`wf-1795647813045`):**

1. **1-game fill-in distortion:** `Yaxel Lendeborg` (GSW) triggered `Tier-1 Q` (`uncertain_questionable`) from a single short-handed game while `Curry`/`Butler`/`Porzingis` were out, and `Aday Mara` (OKC) outranked `Anthony Edwards`, `Chet Holmgren`, `Jalen Williams`, and `Donte DiVincenzo` — all of whom still fell into `0.5 depth` on `nba-401909320` (`7 OUT [impact 4.5: Aday Mara + 6 depth]` vs `3 OUT [impact 1.5: 3 depth]`).
2. **Stale `picks=3` in `summary`:** `rawFinalAnalysisPayload.summary` printed `"Key counts: games=20, covered=20, picks=3."` even though `picks` contained `2` legs (`R2`, `R4`).

---

## Execution Rules & Token-Saving Guardrails

1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `fix/swarm-final-polish`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Require `>= 2` Games for Boxscore `Tier-1` / `Tier-1 Q`, Fix Remaining Unlogged `0.5 depth` Leak & Support `*_roster_meta`

### Observed Edge Cases (`wf-1795647813045`)

- `nba-401909324`: `Yaxel Lendeborg` tagged `Tier-1 Q` from 1 boxscore game on an injured GSW roster.
- `nba-401909320`: `Anthony Edwards`, `Donte DiVincenzo`, `Chet Holmgren`, `Jalen Williams` scored `0.5 depth` while `Aday Mara` was highlighted (`impact 4.5: Aday Mara + 6 depth` vs `1.5: 3 depth`).

### Search Anchors

- `"get_injury_and_roster_delta"`, `"Tier-1 Q"`, `"depth"`, `"unlogged"`, `"espn_season_stats"`, `"nhl_club_stats"`

### Required Changes

1. **Minimum Sample Gate for Boxscore `Tier-1` / `Tier-1 Q` Promotion:**
   - For non-QB / non-G players scored purely from `espn_boxscore` rows, require **`>= 2` logged games** (or a season-baseline row from `espn_season_stats` / `nhl_club_stats` with `games_played >= 5`) before promoting to **Tier-1** (`3.0+`) or triggering **`Tier-1 Q`** (`uncertain_questionable`).
   - A 1-game boxscore cameo (`games === 1`) caps at **Tier-2** (`1.5–2.0`) and never triggers `Tier-1 Q`.
2. **Close the Remaining Unlogged -> `0.5 depth` Code Path:**
   - Audit every branch in `get_injury_and_roster_delta` that assigns `0.5` (`depth`).
   - Enforce strictly: if an injured player has `0` boxscore rows (or only `0`-minute DNP rows) AND no `espn_season_stats`/`nhl_club_stats` row AND no `depth_rank >= 3`, NEVER assign `0.5 depth` when their team has `< 5` distinct logged `game_date`s — assign neutral **`1.0` (`unlogged`)** so multi-week `OUT` stars (`Edwards`, `Holmgren`, `Jalen Williams`) are never downgraded below `1.0` while awaiting season-stats rows.
3. **Support `espn_roster_meta` and `nhl_roster_meta` Rows:**
   - Recognize `source: "espn_roster_meta"` and `"nhl_roster_meta"` from `player_game_logs`:
     - NFL offensive linemen (`position` in `["LT", "RT", "OT", "T", "LG", "RG", "G", "OG", "C"]`) with `experience_years >= 4` (or `depth_rank === 1`) score **Tier-2** (`1.5`), not `depth`.
     - Other `games_played === 0` roster-meta rows score neutral `1.0` (`unlogged`, or `0.5` if `experience_years === 0` rookie depth).

### Acceptance Criteria

- Unit test (1-game fill-in): `Yaxel Lendeborg` with 1 boxscore game (`31` min, `19` pts) caps at `Tier-2` and does NOT emit `Tier-1 Q` `uncertain_questionable`.
- Unit test (thinly logged team `< 5` dates): `nba-401909320` with `Aday Mara` logged (1 game) and `Edwards`/`Holmgren`/`Jalen Williams` unlogged scores unlogged players at `1.0` (`unlogged`), NOT `0.5` (`depth`).
- Unit test (NFL O-line `espn_roster_meta`): `Kevin Zeitler` (`position: "G"`, `experience_years: 14`, `games_played: 0`) scores `Tier-2` (`1.5`).

---

## S2: Reconcile `summary` `"picks=N"` Count Strictly With `compiled.picks.length`

### Observed Nit (`wf-1795647813045`)

- `summary` printed `"Key counts: games=20, covered=20, picks=3."` on a 2-leg parlay (`picks.length === 2`).

### Search Anchors

- `"Key counts:"`, `"picks="`, `"rawFinalAnalysisPayload"`, `"summary"`

### Required Changes

- In the Compiler post-processor, synchronize any `"picks=<N>"` token in `summary` with `compiled.picks.length` (e.g., replacing `/\bpicks=\d+\b/i` with `picks=${compiled.picks.length}`) so `summary` never contradicts `picks[]`.

### Acceptance Criteria

- Unit test: Compiled payload with `picks.length === 2` and draft summary `"Key counts: games=20, covered=20, picks=3."` normalizes cleanly to `"Key counts: games=20, covered=20, picks=2."`.

---

## Verification Commands

```powershell
npx tsc --noEmit
npx vitest run
```
