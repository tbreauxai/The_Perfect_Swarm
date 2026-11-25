# Engineering Fix Spec — `The_Perfect_Swarm` (`wf-1795624413788`: False `row_side_mismatch` Veto)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits and zero SQL migrations.
**Triggering Incident (`wf-1795624413788`):** `a1` proposed `R2` (`New York Islanders ML -122`) with rationale `"Islanders' home form and Blues' injury depletion favor NYI moneyline."` The deterministic `row_side_mismatch` validator scanned the entire concatenated line including the rationale after `—`, matched `"Blues"` (`St. Louis Blues`), and falsely vetoed `R2`:
`Veto: Row side mismatch — Row R2 is "ML New York Islanders(-122)" (New York Islanders), cannot be assigned to "New York Islanders ML — Islanders' home form and Blues' injury de" (St. Louis Blues).`

---

## Execution Rules & Token-Saving Guardrails

1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (e.g., `fix/swarm-wf-1795624413788`), NOT `main`.
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions.

---

## S1: Scope `row_side_mismatch` Strictly to the Pick's Side Label (Ignore Rationale Text After `—` / `-` / `:`)

### Search Anchors

- `"Row side mismatch"`, `"row_side_mismatch"`, `"cannot be assigned to"`

### Required Changes

1. **Isolate Side Label Before Team Extraction:**
   - When validating whether a proposed pick's side matches the board row `R#`:
     - Prefer structured `pick.side` over prose lines like `"R2: New York Islanders ML — Islanders' home form and Blues' injury depletion..."`.
     - If parsing from a summary/keyFinding string, strip everything from the first rationale delimiter (`—`, `–`, `-`, `because`, `over`, `vs`, `against`) onward BEFORE running team-name matching.
2. **Prevent Opponent Mention in Rationale From Overriding Picked Team:**
   - If the extracted side label clearly names the row's own team (`New York Islanders ML`) before any delimiter, NEVER trigger `row_side_mismatch` because the opponent (`Blues`, `Tampa Bay`, `OKC`) is mentioned later in the explanation.
   - Continue to trigger `row_side_mismatch` when the actual side label names the wrong team (e.g., `row: "R2"` (`ML New York Islanders`) paired with `side: "St. Louis Blues ML"`).

### Acceptance Criteria

- Unit test (false-positive regression): `R2` (`ML New York Islanders(-122)`) with `"New York Islanders ML — Islanders' home form and Blues' injury depletion favor NYI moneyline."` produces **zero** `row_side_mismatch` veto.
- Unit test (true-positive guard): `R2` (`ML New York Islanders(-122)`) with `side: "St. Louis Blues ML"` DOES trigger `row_side_mismatch`.

---

## Verification Commands

```powershell
npx tsc --noEmit
npx vitest run
```
