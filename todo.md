# Engineering Fix Spec — `The_Perfect_Swarm` (`wf-1795652004895`: Per-Pick Grounding Isolation, Gemini 4 Hydrogen / 3.8 Thinking Hygiene & Long-Term `OUT` Depth Guard)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits and zero SQL migrations.
**Baseline:** `1`-game fill-in star guard (`Yaxel Lendeborg`), `summary` `picks=N` sync, `1.19s` Groq Critic, and `2.6s–3.5s` `gemini-3.5-flash-lite` Manager/Verifier are verified live. Do NOT re-audit them.

---

## Execution Rules & Token-Saving Guardrails

1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `fix/swarm-wf-1795652004895`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Isolate `symmetric_injury_misread`, `model_signal_misread` & `contra_steam_misread` Strictly to Each Pick's Own Claims

### Observed Failure (`wf-1795652004895`)

- Both `a1` and `a2` agreed on `R1` (NYI: form + steam), `R2` (MIN: model_signal + health), and `R62` (ANA: form + health).
- Deterministic checks scanned `a2`'s generic multi-leg intro (`"These picks satisfy at least 2 of the 3 pillars: form/diff edge, steam or model_signal lean, and clean/asymmetric health"`) and falsely vetoed `R1` for `symmetric_injury_misread` and `R62` for `model_signal_misread`.

### Search Anchors

- `"symmetric_injury_misread"`, `"model_signal_misread"`, `"contra_steam_misread"`, `"covered by seat analysis"`, `"seat analysis claims"`

### Required Changes

1. **Validate Per-Pick Text Only:**
   - Inspect each pick's own `pick.reason` and `pick.reasons[]` first.
   - Only inspect sentences from seat `analysis` prose that **explicitly reference that pick's `row` ID (`R1`, `R62`) OR that specific team/mascot (`Islanders`, `Ducks`)** in the same sentence — and ignore generic 3-pillar framework overview sentences (`"at least 2 of the 3 pillars"`, `"form/diff edge, steam or model_signal"`, `"based on form, health, and steam"`).
   - NEVER scan the concatenated multi-pick digest block across legs so Leg 2's health claim can never veto Leg 1.
2. **Preserve True-Positive Detection:**
   - Continue vetoing when a pick's own `reason`/`reasons[]` or a sentence naming that specific team falsely claims a health edge on a `symmetric`/`uncertain_questionable` game, `model_signal` when slate tag is `none`/`neutral`, or favorable steam when steam is `AGAINST` that side.

### Acceptance Criteria

- Unit test (`wf-1795652004895` 3-leg fixture): `R1` (NYI, `symmetric`, `"strong form and steam"`) + `R2` (MIN, `lean_home`, `home_advantage`) + `R62` (ANA, `model_signal=none`, `home_advantage`, `"form and health"`) with generic 3-pillar intro -> **0** `symmetric_injury_misread` and **0** `model_signal_misread` vetoes.
- Unit test (true positives): `R1` claiming `"clear health advantage"` on `symmetric` DOES veto; `R62` claiming `"model_signal lean_home"` on `model_signal=none` DOES veto.

---

## S2: Wire `gemini-4-hydrogen` & `gemini-3.8-flash` Thinking Hygiene, `15s` Timeout & Instant `limit: 0` Paid-Model Skip

### Observed Failure (`wf-1795652004895`)

- `a1` (`gemini-3.8-flash`) timed out after `28,000ms` (`34.5s` elapsed) because default unbounded thinking ran long, then failed over to Cloudflare (`+13.9s`) instead of a fast Gemini sibling.
- `gemini-4-hydrogen` defaults to `high` thinking, supports `low | medium | high | xhigh` (does **NOT** support `minimal`), and ignores/rejects legacy Gemini 2.5 params (`thinking_budget`, explicit caching).

### Search Anchors

- `"gemini-3.8-flash"`, `"gemini-4-hydrogen"`, `"Gemini request timed out"`, `"28000"`, `"thinkingLevel"`, `"thinking_level"`, `"Failover"`

### Required Changes

1. **Per-Seat Thinking Level & Gemini 4 API Hygiene:**
   - For `gemini-4-*` (including `gemini-4-hydrogen`) and `gemini-3.8-flash` / `gemini-3.6-flash`:
     - Pass `thinkingConfig: { thinkingLevel: "low" }` (NEVER `"minimal"` on `gemini-4-*` — map any `"minimal"` request to `"low"` for `gemini-4-*`).
     - Strip `thinking_budget` and omit `temperature` / `topP` / `topK` on `gemini-3.6+` and `gemini-4-*` (avoiding silent ignores or out-of-range `400`s).
   - If `a1` (`Quant Proposer`) fails over to `gemini-3.5-flash-lite`, use `thinkingLevel: "medium"` for `a1` proposer quality, while keeping `manager` and `verifier` at `"low"`.
2. **`15s` Proposer Timeout + Fast Sibling Failover:**
   - Cap `a1`/`a2` Gemini proposer single-attempt timeout to `15,000ms` (not `28,000ms`).
   - Order `a1` Gemini sibling failover as `gemini-4-hydrogen -> gemini-3.8-flash -> gemini-3.5-flash-lite` before leaving Gemini for `Cloudflare` / `Mistral`.
3. **Instant `0ms` Skip on Paid-Only Free-Tier `limit: 0` Errors:**
   - When Gemini returns HTTP `429` whose error body contains `free_tier` AND `limit: 0` (e.g., if a user manually selects a paid-only model like `gemini-4-argon` on a free key), immediately mark that specific model ineligible on cooldown (do NOT retry it or sleep) and jump straight to the next eligible model in `0ms`.

### Acceptance Criteria

- Unit test (`gemini-4-hydrogen`): Sends `thinkingConfig: { thinkingLevel: "low" }` (never `"minimal"`), omits `thinking_budget` and `temperature`, and aborts at `15,000ms`.
- Unit test (`a1` failover to `gemini-3.5-flash-lite`): Uses `thinkingLevel: "medium"` on `a1` (and `"low"` on `manager`/`verifier`).
- Unit test (`429 limit: 0`): Paid-only model error skips retries and jumps to next sibling in `< 50ms`.

---

## S3: Never Downgrade `0`-Row `OUT` Players to `0.5 depth` Based Only on Team Game Count

### Observed Edge Case (`wf-1795652004895`)

- On `nba-401909320`, once OKC/MIN reached `>= 5` logged boxscore dates, multi-week `OUT` stars (`Anthony Edwards`, `Chet Holmgren`, `Jalen Williams`, `Donte DiVincenzo`) with `0` rows fell into `0.5 depth` while `Aday Mara` outranked them.

### Search Anchors

- `"get_injury_and_roster_delta"`, `"depth"`, `"unlogged"`, `"espn_roster_meta"`, `"espn_season_stats"`

### Required Changes

- Assign `0.5` (`depth`) **ONLY** when positive evidence exists:
  1. Logged boxscore or season-stats rows with low usage (`NBA < 15` MPG, `NHL < 12` TOI, `NFL` depth usage), OR
  2. Confirmed `depth_rank >= 3` from `espn_depthchart`, OR
  3. `espn_roster_meta` / `nhl_roster_meta` confirming `experience_years === 0` and `games_played === 0`.
- Any `OUT` player with **zero** logged rows always scores neutral **`1.0` (`unlogged`)** regardless of how many games their team played while they were injured.

### Acceptance Criteria

- Unit test: Team with `6` distinct logged `game_date`s and an `OUT` player (`Anthony Edwards`) with `0` rows scores `1.0` (`unlogged`), NOT `0.5` (`depth`).
- Unit test: Player with `3` logged games averaging `9.2` MPG still scores `0.5` (`depth`).

---

## Verification Commands

```powershell
npx tsc --noEmit
npx vitest run
```
