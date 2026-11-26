# Engineering Fix Spec — `The_Perfect_Swarm` (`wf-1795730839067`: Grounding Record-Split Matching, Negation-Aware Injury Disclaimer Guard & Verifier Seat ID Separation)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero edits to `DuelOdds` and zero SQL migrations.
**Baseline:** `31.3s` Swarm runtime, `gemini-embedding-2` + `pwa_swarm_dev_cortex_v4` + `appliedDomains` telemetry, `7.66s` `gemini-4-hydrogen`, and `3.99s` `nemotron-3.5-lightning-30b-a3b` Manager are verified live. Do NOT re-audit them.
**Observed Failures (`wf-1795730839067`):**

1. Attempt 1 failed with `Ungrounded record/form claim ("4-1 form") not found in a successful tool result`, even though `get_matchup_fundamentals` returned `Season 9-1 (4-1 Home, Diff +10.5)` for Buffalo and `W-L 4-1` for Texas Tech.
2. Attempt 2 failed with `symmetric_injury_misread` on the explicit disclaimer `"Health Balance is uncertain_questionable for Buffalo, treating as disqualifying for roster health edge."` because the regex matched `"roster health edge"` while ignoring negation/disclaimer terms.
3. `diagnostics.failovers[]` emitted a phantom `[critic] gemini/gemini-3.5-flash-lite -> groq/openai/gpt-oss-120b` failover because Pass 1 Critic and Verification Critic both use `seat: "critic"`.

---

## Execution Rules & Token-Saving Guardrails

1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `fix/swarm-wf-1795730839067`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Match Valid Split/Overall Records (`4-1 Home`, `W-L 4-1`, `home_record`, `away_record`) in Record/Form Grounding Check

### Search Anchors

- `"Ungrounded record/form claim"`, `"not found in a successful tool result"`, `"get_matchup_fundamentals"`

### Required Changes

- When validating a cited numeric record (e.g., `"4-1 form"`, `"9-1 record"`, `"4-1 home"`, `"5-0 L5"`), extract the numeric `W-L` / `W-L-T` token (`"4-1"`) and verify it against ALL grounded record fields in the successful `get_matchup_fundamentals` dossier and tool outputs for the covered games:
  - `W-L` window record (`wins-losses`, e.g., `4-1`)
  - `Season` overall record (`season_wins-season_losses`, e.g., `9-1`)
  - `Home` and `Away` split records (`home_record`, `away_record`, e.g., `4-1 Home`, `3-2 Away`)
  - `L5` record (`last5_wins-last5_losses`, e.g., `5-0`)
  - Slate standings/splits text in the prompt payload
- Do NOT require the exact literal phrase `"4-1 form"` to appear verbatim in tool text when `"4-1"` is present as a grounded record for that game. Continue flagging genuinely fabricated records (e.g., citing `"8-0"` when the team is `4-6`).

### Acceptance Criteria

- Unit test (`wf-1795730839067` fixture): Dossier containing `Season 9-1 (4-1 Home, Diff +10.5)` and `W-L 4-1` with prose `"4-1 form"` passes with **0** `Ungrounded record/form claim` vetoes.
- Unit test (true positive): Prose claiming `"7-0 form"` when no `7-0` record exists anywhere in fundamentals still vetoes.

---

## S2: Make `symmetric_injury_misread` Negation- and Disclaimer-Aware

### Search Anchors

- `"symmetric_injury_misread"`, `"health-advantage claim"`, `"uncertain_questionable"`, `"roster health edge"`

### Required Changes

- Before triggering `symmetric_injury_misread` on a matched sentence/clause containing health/injury-edge phrasing (e.g., `"health edge"`, `"roster health advantage"`, `"injury advantage"`), check the same clause for explicit negation, disclaimer, or caution language:
  - `/\b(no|not|without|lacks?|neither|disqualif\w*|cannot claim|does not (hold|have|provide|offer|grant)|do not|uncertain_questionable|symmetric|neutral|caution|risk|flag|caveat|voids?|negat\w*|ruled out as)\b/i`
- If the clause explicitly states that `Health Balance` is `uncertain_questionable` or `symmetric` and disclaims/disqualifies a health edge (e.g., `"Health Balance is uncertain_questionable for Buffalo, treating as disqualifying for roster health edge"`), do **NOT** fire `symmetric_injury_misread`.
- Continue vetoing genuine affirmative claims on `symmetric` / `uncertain_questionable` / opponent-favored games (e.g., `"Steam movement and health balance favor TCU"` when TCU @ Texas Tech is `symmetric`).

### Acceptance Criteria

- Unit test (`wf-1795730839067` fixture): Sentence `"Health Balance is uncertain_questionable for Buffalo, treating as disqualifying for roster health edge."` produces **0** `symmetric_injury_misread` vetoes.
- Unit test (true positive): `"Steam movement and health balance favor TCU"` on `Health Balance: symmetric` STILL fires `symmetric_injury_misread`.

---

## S3: Separate `"verifier"` Seat ID From `"critic"` So `diagnostics.failovers[]` Stops Emitting Phantom Failovers

### Search Anchors

- `"Failover transition detected from seat execution"`, `"seatTimings"`, `"diagnostics"`, `"failovers"`

### Required Changes

- Emit `seat: "verifier"` (or compare each `seatTimings` entry only against that specific stage's own configured provider/model) instead of matching Pass 1 `critic` (`groq/openai/gpt-oss-120b`) against Verification `critic` (`gemini/gemini-3.5-flash-lite`).
- Ensure the fallback safeguard in `diagnostics.failovers` ONLY synthesizes an entry when `entry.status === "failover"` (never when all entries have `status: "ok"`).

### Acceptance Criteria

- Unit test: A run where `critic (Pass 1)` executes `groq/openai/gpt-oss-120b` (`status: "ok"`) and `verifier` executes `gemini/gemini-3.5-flash-lite` (`status: "ok"`) produces `diagnostics.failovers === []`.

---

## Verification Commands

```powershell
npx tsc --noEmit
npx vitest run
```
