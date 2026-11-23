# Engineering Fix Spec — `The_Perfect_Swarm` Delta (`wf-1795391975523`)

**Repo Scope:** `C:\Dev\Workspaces\The_Perfect_Swarm` ONLY. Zero cross-repo edits and zero SQL migrations.
**Already Implemented & Verified Live (DO NOT RE-AUDIT):** `"St."` summary splitter, Groq Critic proposed-only scoping, `[extended_move]` tag, disabling stale `| LIVE` Cortex Supabase pull in `two-hop` mode, and Compiler Rule-4 odds-echo stripping.
**Triggering Incident (`wf-1795391975523`):** Critic LLM returned `pass: true` on both verification attempts, yet deterministic post-verifier overrides failed both attempts (`RLAIF 35%`, `93.6s`), dropping a clean `R39` pick. Upstream, Hop-1 `1500ms` timeouts blinded 2 games, total steam hid Denver's side steam, and cross-seat consensus on `R39` was falsely flagged `duplicate_leg`.

---

## Execution Rules & Token-Saving Guardrails
1. **HARD CONSTRAINT (Local-Only):** Local edits, `npx tsc --noEmit`, and targeted `npx vitest run` ONLY. Do **NOT** run `git push`, merge to `main`, deploy scripts, or mutate live Render/Supabase/Qdrant services.
2. **Branch Check First:** Confirm you are on a feature branch (NOT `main`).
3. **Minimal File Reads:** Grep using the exact **Search Anchors** below and read ONLY matched files/functions. Do NOT scan unrelated modules or re-check already-implemented fixes.

---

## P0-1: Fix Deterministic Grounding Verifier Corpus (`idx 59`)

### Observed Failure
- Deterministic override failed Attempt 1 claiming Denver's `"6-2 record"` was ungrounded, even though Hop-1 `get_matchup_fundamentals` returned `Season 11-6 (6-2 Away, Diff +1.2)` (the verifier checked against older slate standings `4-2 Away` instead of `curatedDossier`).

### Search Anchors
- `"Verification FAILED"`, `"ungrounded"`, `"RLAIF"`, `"6-2"`, `"curatedDossier"`

### Required Changes
- Build the deterministic claim/record grounding corpus from the union of Hop-1 `curatedDossier` tool summaries (`get_matchup_fundamentals`, `get_injury_and_roster_delta`, `get_market_movement`) AND `COMPACT SLATE`.
- Treat `curatedDossier` stats (`Season`, `Home`/`Away` split records, `L5`, `Net Margin`) as authoritative over any older standings block in `payload.data`.

### Acceptance Criteria
- Unit test: `"Denver Nuggets hold a 6-2 away record"` passes deterministic grounding when `curatedDossier` contains `Season 11-6 (6-2 Away, Diff +1.2)`, even if raw slate standings say `4-2 Away`.

---

## P0-2: Fix Deterministic Veto-Leakage Override & Run Post-Prune Sync Before Verification (`idx 68–69`)

### Observed Failure
- Critic LLM approved Attempt 2 (`pass: true`) with only `R39` Blues ML in `picks[]`, yet the deterministic override failed Attempt 2 (`RLAIF 35%`) claiming `"vetoed Nuggets leg still recommended in analysis"` — either due to a naive team-name substring match on a rejection clause or running before post-prune prose cleanup.

### Search Anchors
- `"Selected Wagers"`, `"vetoed"`, `"RLAIF"`, `"Verification FAILED"`, `"default-insight-list"`

### Required Changes
1. Run deterministic post-prune cleanup (removing vetoed legs from `picks[]`, `Selected Wagers`, `InsightList`, and any active recommendation sentence in `analysis`) **BEFORE** the deterministic verifier scores the attempt.
2. In the deterministic veto-leakage check, do **NOT** fail if the vetoed leg is absent from `picks[]`, `Selected Wagers`, and `InsightList` and is only mentioned in a rejection/explanation clause (containing terms like `vetoed`, `rejected`, `dropped`, `excluded`, `removed`, `ruled out`). Only fail if the vetoed row/team is still actively recommended.

### Acceptance Criteria
- Unit test: Manager output with `picks: [R39]`, `Selected Wagers: [R39]`, and `analysis: "Proceed with St. Louis Blues ML (R39). Denver Nuggets -9.5 was vetoed by the Risk Critic..."` passes deterministic verification on Attempt 1 (does NOT trigger `RLAIF 35%`).
- Unit test: Manager output that still lists the vetoed team inside `picks[]` or `Selected Wagers` still fails verification.

---

## P0-3: Emit Side Steam and Total Steam Independently in `get_market_movement` (`idx 42`)

### Observed Failure
- On `nba-401910032` (Denver @ Chicago), spread moved `-8.5 -> -9.5` (`Delta: 1`) and ML moved `-360 -> -405`, while total moved `237.5 -> 236.5`. Because `get_market_movement` emitted only one `Steam:` line (`Steam: TOWARD Under`), Denver's side steam was hidden and `R20` (`Denver Nuggets -9.5`) was falsely vetoed as `ungrounded_claim`.

### Search Anchors
- `"Steam: TOWARD"`, `"get_market_movement"`, `"Divergence: single_book"`

### Required Changes
- Compute side steam (spread move `>= 1.0` pt NBA/NFL or `>= 0.5` key move, OR ML shift `>= 2.5pp` implied) and total steam independently.
- Whenever BOTH side and total move, emit both on the `Steam:` line instead of letting total steam overwrite side steam, e.g.:
  `Steam: Side TOWARD away Denver Nuggets (-8.5 -> -9.5, 1.0 pt) | AGAINST home Chicago Bulls (+8.5 -> +9.5) | Total TOWARD Under (237.5 -> 236.5, -1.0 pts) | Divergence: single_book`
- Preserve existing `[extended_move: verify remaining value]` tagging on `>= 2.0` pt spreads or `>= 5.0pp` ML moves.

### Acceptance Criteria
- Unit test: `nba-401910032` (`spread -8.5 -> -9.5`, `total 237.5 -> 236.5`) emits both `TOWARD away Denver Nuggets` and `TOWARD Under`.

---

## P0-4: Scope `duplicate_leg` Strictly Within a Single Seat's Parlay (`idx 42`)

### Observed Failure
- `a1` proposed `[R39, R20]` and `a2` proposed `[R39]`. Risk Critic flagged `a1` and `a2` both choosing `R39` (`St. Louis Blues ML`) as `anomalies: ["duplicate_leg"]` ("duplicate ML leg").

### Search Anchors
- `"duplicate_leg"`, `"duplicate ML leg"`, `"anomalies"`

### Required Changes
- Two different proposer seats agreeing on the same row/side (`a1: R39`, `a2: R39`) is **consensus**, NEVER `duplicate_leg`.
- Trigger `duplicate_leg` ONLY when a single seat's `picks[]` (or the compiled `picks[]`) contains `>= 2` legs sharing the same canonical `event_id`.

### Acceptance Criteria
- Unit test: `a1` proposing `[R39, R20]` and `a2` proposing `[R39]` produces zero `duplicate_leg` flag.
- Unit test: A single seat proposing `[R39, R8]` on `nhl-401892770` DOES produce `duplicate_leg`.

---

## P0-5: Fix Hop-1 `1500ms` Timeout & Concurrency Storm (`tool_call_trace[0..4]`)

### Observed Failure
- Firing 27+ Hop-1 RPCs simultaneously at `T=0` hit cold-connection latency and timed out 5 of the first 6 calls at `1501–1599ms` (`exceeded 1500ms execution timeout`), blinding both proposers to `nba-401910033` (3/3 failed) and half of `nfl-401873077` (2/3 failed).

### Search Anchors
- `"exceeded 1500ms execution timeout"`, `"1500"`, `"UnifiedHop1"`, `"Hop 1 Dossier Fetch"`

### Required Changes
- Raise Hop-1 per-tool timeout from `1500ms` to `4000ms`.
- Cap in-flight Hop-1 tool calls to `6`–`8` concurrent promises (simple concurrency queue/pool instead of unbounded `Promise.all`).
- Add 1 automatic retry on timeout error before recording `status: "error"`.

### Acceptance Criteria
- Unit test: Hop-1 runner enforces max concurrency `<= 8`, uses `4000ms` timeout, and retries a single transient timeout once before failing.

---

## P1-1: Finish Wiring Starter-Weighted Injury Impact Into `Summary:` & `Health Balance`

### Observed Gap (`wf-1795391975523`)
- Raw injury rows (`llmAndToolEvents[16]`) now carry `impact_tier` and `impact_weight` (e.g., `Bryan Rust: impact_tier: 2, impact_weight: 1`), yet `curatedDossier` `Summary:` lines still print raw counts only (`Dallas Stars (5 OUT, 0 Q) vs Pittsburgh Penguins (5 OUT, 0 Q) | Health Balance: symmetric`) without `[impact ...]`, and `impact_weight` is defaulting flat (`1`) instead of Tier 1 (`3.0`/`4.0`/`5.0`), Tier 2 (`1.5`), Tier 3 (`0.5`).

### Search Anchors
- `"impact_tier"`, `"impact_weight"`, `"Health Balance:"`, `"get_injury_and_roster_delta"`

### Required Changes
1. Verify why `impact_weight` resolved to `1` on Tier 2 and ensure tier weights are applied (`QB1: 5.0`, `Starting G: 4.0`, `Tier 1 core: 3.0`, `Tier 2 rotation: 1.5`, `Tier 3 depth: 0.5`; `Q` at `0.5x`; flat `1.0` fallback only when team has zero game-log coverage).
2. Surface weighted `OUT` impact in the `Summary:` line (e.g., `Utah Jazz (3 OUT [impact 9.0], 0 Q) vs Dallas Mavericks (5 OUT [impact 4.5], 0 Q) | Health Balance: away_advantage (Dallas Mavericks, +4.5 impact edge)`).
3. Classify `home_advantage` / `away_advantage` using weighted `OUT` impact gap (`>= 2.5`), and force `uncertain_questionable (<Team>: Tier-1 Q <PlayerName>)` whenever a Tier-1 star (e.g., Giannis, Tatum, KAT, QB1, starting G) is `QUESTIONABLE`.

### Acceptance Criteria
- Unit test: Utah missing 3 Tier-1 players (`9.0`) vs Dallas missing 2 Tier-2 + 3 Tier-3 (`4.5`) prints `[impact 9.0]` / `[impact 4.5]` and classifies `away_advantage (Dallas Mavericks)`.
- Unit test: A single Tier-1 `QUESTIONABLE` star forces `uncertain_questionable`.

---

## P1-2: Skip `get_environment_and_weather` for Indoor Leagues & Preserve Price-Band Text in Digest Scrubber

### Observed Failures (`wf-1795391975523`)
1. Verification loop wasted tool calls pulling `get_environment_and_weather` for indoor NHL/NBA games (`nhl-401892770`, `nba-401910032`).
2. Digest odds scrubber stripped `-220` and `+150` from `"-220 to +150"`, leaving `"Both legs are priced within the to window."`.

### Search Anchors
- `"get_environment_and_weather"`, `"within the"`, `"-220"`, `"keyFindings"`

### Required Changes
1. Never call `get_environment_and_weather` during Critic or verification loops when `event_id` starts with `nba-`, `nhl-`, `ncaab-`, or `wnba-` (outdoor leagues only: `nfl-`, `ncaaf-`, `mlb-`, `soccer`).
2. Exempt policy price-band phrases (`between -220 and +150`, `-220 to +150`, `steeper than -250`) from the specialist digest odds scrubber.

### Acceptance Criteria
- Unit test: Verifier skips `get_environment_and_weather` for `nba-401910032` and `nhl-401892770`, and calls it for outdoor `nfl-*` games.
- Unit test: Digest scrubber preserves `"priced within the -220 to +150 window"` verbatim.

---

## Verification Commands
```powershell
npx tsc --noEmit
npx vitest run
```