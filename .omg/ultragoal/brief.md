# Ultragoal Brief: Slate ML Option Retention, Proposer Header Budget & Market/Odds Pull-Before-Pass (S0–S5, Base 5db4fe57)

- **Objective:** Implement S0–S5 from `todo.md` on `main` (base `5db4fe57`), one commit per step, then run `VERIFY` and push `origin main`.
- **Base Commit:** `5db4fe57` (`main`)
- **Constraints:**
  - Node 22 strip-only TS (no parameter properties, enums, namespaces, `import=require`, decorators).
  - Keep `seatBudget` caps (groq 5600, DuelOdds slate 2000); S2 only resizes the proposer header slice inside each seat's own cap.
  - Synthetic header options stay `id: ''`.
  - No DB/KV writes, migrations, flags, crons, live calls, or token printing.
  - Explicit `git add <files>` (never `-A`); no reset/restore/clean/rebase/squash/force-push.
  - Note: `todo.md` has local uncommitted edits (`M todo.md`), and `/workspace/sw_n20i_repro/` is not present on this Windows host, so S0 authors `src/__repro__/runNov20h.repro.test.ts` (N, O, P).
