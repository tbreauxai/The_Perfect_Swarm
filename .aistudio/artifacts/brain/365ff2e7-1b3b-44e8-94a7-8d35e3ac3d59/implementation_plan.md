# Closed-Loop Qdrant & DuelOdds (Supabase) Learning Architecture Plan

## 1. Architectural Overview & Zero-Migration Guarantee
All upgrades operate strictly against the existing Qdrant collections (`pwa_swarm_dev_cortex_v2`, `swarm_learning`) and existing DuelOdds Supabase tables (`game_judgments`, `line_snapshots`) with **zero database schema migrations** and **zero changes required in the DuelOdds repository**.

---

## 2. Core Learning Engine & Memory Cortex Upgrades

### A. Decouple Response Cache Bypass from Qdrant `MemoryCortex` Retrieval (`src/swarm/engine/memoryGrounding.ts`, `src/swarm/types.ts`)
- **Problem Fixed**: `runMorningSlate()` sets `bypassCache: true` so one game's judgment never hits another game's cached verdict, which unintentionally skipped `memoryCortex.retrieve()` and `memoryCortex.retrieveExemplars()`.
- **Implementation**:
  - Separate response cache short-circuiting (`bypassCache`) from memory grounding (`disableMemoryRetrieval`, defaulting to `false`).
  - Ensure `resolveMemoryGrounding()` always queries Qdrant for historical baselines, team/entity memories, and graded post-mortems even when `bypassCache: true`, while only skipping `lookupActionPlan` when `bypassCache` is set.

### B. Rich Verdict & Argument Serialization into Qdrant (`src/swarm/engine/learningPipeline.ts`, `src/swarm/memory/cortex.ts`)
- **Problem Fixed**: `learningPipeline.ts` previously stored only `Result: ${finalAnalysis.ui_title || 'Analysis complete'}`, losing the structured verdict for `morning_judge` runs and generative dashboards.
- **Implementation**:
  - Build a structured verdict summarizer `formatLearnedVerdictContent(task, finalAnalysis, feedback)` in `learningPipeline.ts` that extracts:
    - For DuelOdds (`morning_judge` / sports verdicts): `likelyWinner`, `winProbHome`, `fairSpread`, `fairTotal`, `totalLean`, top `arguments` (`advocate`, `weight`, `claim`), and `invalidationConditions`.
    - For Generative UI dashboards: `ui_title` plus top `MetricCard` values and `InsightList` alerts/recommendations.
  - Store structured metadata fields (`predictedProbability`, `fairSpread`, `likelyWinner`, `advocateSummary`) in the Qdrant point payload so future retrievals surface exact historical numbers.
  - Upgrade `gradeMemoryByWorkflowId()` in `src/swarm/memory/cortex.ts` to also record `brierScore`, `margin`, and `settledSummary` when a game or workflow is graded.

### C. Contrastive Episodic Reflexion: Victory Exemplars vs. Failure Post-Mortems (`src/swarm/memory/cortex.ts`, `src/swarm/engine/memoryGrounding.ts`)
- **Implementation**:
  - Add `retrieveContrastivePostMortems(query, options)` on `MemoryCortex` that retrieves two targeted sets of graded memories matching the current `appId`, `domain`, or `entityIds` (e.g. team abbreviations):
    1. **Validated Exemplars (`outcome === 'win'` or `qualityRating >= 0.75`)**: Proven high-accuracy reasoning patterns in this domain/matchup.
    2. **Failure Post-Mortems / Anti-Exemplars (`outcome === 'loss'` or `brierScore >= 0.28`)**: Explicit pitfall warnings showing where the Swarm previously mispriced the team, spread, or regime and why.
  - Inject both blocks into `historicalContext` in `resolveMemoryGrounding()` and emit a structured trace event (`Contrastive Memory & Post-Mortem Retrieval`).

---

## 3. DuelOdds Supabase Live Intelligence & Seat Attribution (`src/swarm/morning/*`)

### A. Live Line-Movement Steam & Team Residual Bias Lookup (`src/swarm/morning/supabase.ts`, `src/swarm/morning/judgePrompt.ts`, `src/swarm/morning/index.ts`)
- **Implementation**:
  - Add `fetchPregameLearningContext(cfg, game, fetchFn)` in `src/swarm/morning/supabase.ts`:
    1. **Line Movement & Steam Vector (`line_snapshots`)**: Queries `line_snapshots` for `event_id` ordered by `snapshot_at ASC`, comparing the `is_baseline=true` opening line against the latest line to compute `spreadDelta`, `totalDelta`, `homeImpliedProbDelta`, and steam direction (`towards_home`, `towards_away`, `stable`).
    2. **Team-Specific Historical Residual Bias (`game_judgments`)**: Queries recent `status=eq.final` rows in `game_judgments` involving `homeTeam` or `awayTeam` to compute historical Swarm spread error ($\text{actual\_margin} - (-\text{fair\_spread})$), win-probability calibration gap, and average Brier score on those specific teams.
  - Inject this `[SUPABASE LIVE MARKET STEAM & TEAM CALIBRATION HISTORY]` section into `buildProposerPrompt()` and `formatGameToColumnar()` in `src/swarm/morning/index.ts` so both Proposers, the Risk Critic, and the GodView Compiler reason over real opening-to-current line movement and historical team-specific pricing errors.

### B. Counterfactual Per-Seat Brier Attribution (`src/swarm/morning/index.ts`, `src/swarm/morning/feedback.ts`, `src/swarm/server/app.ts`)
- **Problem Fixed**: `gradeAndRecordFinalGames()` previously hardcoded `analystLedger.recordOutcome('duelodds', 'Quant Specialist', outcome)` instead of grading the actual seats (`Quant Proposer`, `Market Proposer`, `Risk Critic`, `GodView Compiler`) and their individual advocate leans.
- **Implementation**:
  - In `computeModelSnapshot()` (`src/swarm/morning/judgePrompt.ts`), persist `participatingSeats` (`['Quant Proposer', 'Market Proposer', 'Risk Critic', 'GodView Compiler']`) and `advocateWeights` (from `judgment.arguments`) inside `model_snapshot`.
  - In `gradeAndRecordFinalGames()` (`src/swarm/morning/feedback.ts`), read `model_snapshot` (or `arguments`) from the settled `game_judgments` row and update `analystLedger` and `globalSpecialistProfiler.recordAccuracy()` for the real participating seat roles, weighting high-weight advocates on the winning/losing side.

### C. Cold-Start Empirical Calibration Hydration from Supabase (`src/swarm/morning/supabase.ts`, `src/swarm/server/learningState.ts`)
- **Implementation**:
  - Add `hydrateCalibrationFromSupabase(cfg, fetchFn)` to query up to 250 recent `status=eq.final` rows from `game_judgments` (`event_id`, `workflow_id`, `sport`, `win_prob_home`, `result`, `judged_at`) and feed them into `recordProbabilityObservation({ appId: 'duelodds', ... })`.
  - Call this automatically during `restoreLearningState()` on server boot (when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are present) and at the start of `runMorningSlate()`.

---

## 4. Cortex Diagnostics UI Telemetry (`src/swarm/server/cortexDiagnostics.ts`, `src/components/CortexDiagnosticsViewer.tsx`)
- Extend `buildCortexDiagnostics()` in `src/swarm/server/cortexDiagnostics.ts` to include a `learningTelemetry` object:
  - `calibration`: Fitted Brier score, logit bias, sample size, stated vs. actual hit rate, and per-sport sample counts from `fitCalibration()`.
  - `seatAccuracy`: Per-seat win/loss/push records and empirical accuracy percentages from `analystLedger` and `globalSpecialistProfiler`.
  - `durableStoreStatus`: Qdrant learning store status + Supabase connection status (`configured: boolean`) + contrastive win/loss memory counts.
- Render a **Closed-Loop Learning & Calibration Telemetry** section inside `src/components/CortexDiagnosticsViewer.tsx` (using `font-mono tabular-nums`, clean 1px hairlines, and a manual **"Sync Calibration"** button that calls `/api/swarm/calibrate`).

---

## 5. Verification & Test Plan
- Add unit tests in `src/swarm/morning/learningLoop.test.ts` verifying:
  1. `resolveMemoryGrounding` retrieves Qdrant memories and contrastive win/loss post-mortems even when `bypassCache: true`.
  2. `formatLearnedVerdictContent` preserves full DuelOdds (`winProbHome`, `fairSpread`, `arguments`) and dashboard verdicts in Qdrant.
  3. `fetchPregameLearningContext` computes opening-to-current line movement deltas from `line_snapshots` and team residual bias from settled `game_judgments`.
  4. `gradeAndRecordFinalGames` attributes outcomes to the actual participating seat roles (`Quant Proposer`, `Market Proposer`, `Risk Critic`, `GodView Compiler`) and hydrates `probabilityCalibration`.
- Run `compile_applet`, `lint_applet`, and `vitest` to verify zero regressions across all existing and new tests.
