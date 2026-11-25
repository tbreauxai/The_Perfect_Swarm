# Engineering Fix Spec — `The_Perfect_Swarm` (`wf-1795618886150`)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits and zero SQL migrations.
**Observed Issues (`wf-1795618886150`):**

1. Compiler omitted top-level `criticApproved: true` even though `scorecards` had `{ seat: "Risk Critic", verdict: "approve" }`.
2. On `nhl-401892783`, Proposers picked `R47` (`Carolina Hurricanes -1.5` at `+205`) over `R111` (`Carolina Hurricanes ML` at `-128`) and claimed it sat inside the `-220` to `+150` price band; the digest scrubber also stripped the price-band numbers into `"Both spreads sit in the to range, well within the / window."`.
3. On a 20-game (`120` R-ID) slate, `a1` (`nvidia`) still received all `20/20` full dossier sections (`23,567` chars, `187.8s` latency) while `a2` (`cloudflare`) hit `dossierTruncated: true` (`8/20`). Also `nhl-401892787` printed the same Oct 28 H2H game twice (`PHI vs WAS 2-5` and `WSH vs PHI 5-2`).

---

## Execution Rules & Token-Saving Guardrails

1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `fix/swarm-wf-1795618886150`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Always Emit Top-Level `criticApproved`, Tighten NHL Puckline vs. ML Guidance & Fix Digest Price-Band Scrubber

### Observed Failures (`wf-1795618886150`)

1. `rawFinalAnalysisPayload` omitted top-level `criticApproved` (`undefined`) on a verified `0.98` run with Risk Critic `verdict: "approve"`.
2. `a1` treated NHL `-1.5` puckline (`R47` `+205`) as if it were an NBA `-110` spread inside `-220` to `+150`, ignoring `R111` (`Carolina Hurricanes ML -128`).
3. Digest scrubber blanked numbers in `a1`'s prose, emitting `"Both spreads sit in the to range, well within the / window."`.

### Search Anchors

- `"criticApproved"`, `"wageringPass"`, `"scorecards"`, `"within the"`, `"keyFindings"`, `"GodView Compiler"`, `"-220"`

### Required Changes

1. **Guarantee Top-Level `criticApproved` Boolean on Every Final Payload:**
   - Ensure the Compiler / post-processor ALWAYS sets explicit boolean `criticApproved` (`true` or `false`) on `rawFinalAnalysisPayload`, synchronized with Risk Critic's verdict (`false` if full veto or failed verification, `true` if Critic approved the surviving picks or intentional pass).
2. **NHL Puckline (`-1.5`) vs. Moneyline Price-Band Guard:**
   - In the Proposer calibration prompt (and deterministic price-band check), note explicitly: _"In NHL games, `-1.5` pucklines are typically `+140` to `+225` (often outside the `-220` to `+150` optimal band). Check the row's printed price in `COMPACT SLATE`: prefer the NHL Moneyline when priced between `-220` and `+150` (e.g., `-128` ML over `+205` `-1.5` puckline)."_
3. **Fix Specialist Digest Odds Scrubber Mangling Price-Band Text:**
   - When scrubbing leaked odds from `interimDigests` `keyFindings`/`summary`, either preserve policy price-band expressions (`-220 to +150`, `-110 to -120`) verbatim OR remove the entire redundant price-band clause cleanly—never leave broken holes like `"in the to range, well within the / window."`.

### Acceptance Criteria

- Unit test: Final compiled payload always includes `typeof criticApproved === "boolean"`.
- Unit test (digest scrubber): Never produces `"in the to range"` or `"within the / window"`.

---

## S2: Cap Heavy-Slate Proposer Dossiers (`<= 10` Full Sections) & Deduplicate `WAS`/`WSH` H2H Lines

### Observed Failures (`wf-1795618886150`)

- `a1` (`nvidia`) received `20/20` full sections (`23,567` chars, `9,695` tokens -> `187.8s` runtime), while `a2` (`cloudflare`) truncated at `8/20` (`dossierTruncated: true`).
- `nhl-401892787` emitted duplicate H2H entries for the same game under `WAS` and `WSH`:
  `H2H: 2026-10-28: PHI vs WAS 2-5 (L); 2026-10-28: WSH vs PHI 5-2 (W)`

### Search Anchors

- `"dossierTruncated"`, `"dossierSectionsIncluded"`, `"=== TOP PILLAR CANDIDATES"`, `"H2H:"`, `"get_matchup_fundamentals"`

### Required Changes

1. **Cap Full Dossiers on `>= 12`-Game Slates for Both `a1` and `a2`:**
   - Sort Hop-1 game dossiers by per-side aligned pillar score descending (2–3 aligned pillars first, `uncertain_questionable` and `0`-pillar games last).
   - Inject full dossiers for the **top 8–10 pillar-ranked games** and compact 1-line summaries for remaining games so `a1` stays under `~6,000` input tokens (cutting 20-game latency sharply) and `a2` (`Cloudflare`) sees the top candidates cleanly with `dossierTruncated: false`.
2. **Support `espn_depthchart` Starter Rows in `get_injury_and_roster_delta`:**
   - When reading `public.player_game_logs`, recognize rows with `source === "espn_depthchart"` (`stats.starter === true`, `stats.position`) alongside regular boxscore rows so Tier-1 injured starters (NFL QB1/LT, NHL starting G, NBA starters out since preseason) get real Tier-1 weights (`5.0` / `4.0` / `3.0`) immediately.
3. **Deduplicate `H2H:` Lines by `(game_date, sorted_scores)`:**
   - In `get_matchup_fundamentals` summary formatting, deduplicate H2H rows that share the same `game_date` and identical team/opponent score pair (e.g., `2026-10-28` `5-2` vs `2-5` under `WAS`/`WSH`) so each head-to-head game prints once.

### Acceptance Criteria

- Unit test (20-game slate): `a1` receives `<= 10` full dossier sections (with compact 1-line summaries for the rest) and `a2` has `dossierTruncated === false`.
- Unit test (`get_matchup_fundamentals`): `2026-10-28 PHI vs WAS 2-5` + `2026-10-28 WSH vs PHI 5-2` collapses to 1 H2H entry.
- Unit test (`get_injury_and_roster_delta`): `espn_depthchart` row with `{ position: "QB", depth_rank: 1, starter: true }` scores Tier 1 (`5.0`).

---

## Verification Commands

```powershell
npx tsc --noEmit
npx vitest run
```
