# Sports Betting Swarm Optimizations & Hardening Plan

**Repo:** `The_Perfect_Swarm` (backend)  
**Status:** Complete  
**Objective:** Resolve statistical grading distortions, align test mock contracts, and implement core sports-betting intelligence optimizations across memory, tokenization, consensus, and backtesting.

---

## Phase 1: Push-Aware Quality Drift & Brier Hardening
Fix outcome calibration and Brier scoring distortions where tie/push results are penalized as outright losses.

- [x] **1.1 Hardened Brier Score Calculation on Pushes (`src/swarm/morning/feedback.ts`)**
  - **Location:** [`src/swarm/morning/feedback.ts:118-121`](file:///c:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/morning/feedback.ts#L118-L121)
  - **Issue:** `const homeWin = homeScore > awayScore;` scores tie/push as `homeWin = false` (binary 0 in Brier calculation `(winProbHome - 0)^2`).
  - **Fix:** If `homeScore === awayScore` (or push outcome), calculate Brier against `0.5` neutrality or store `null` for binary moneyline Brier score.
  - **Acceptance:** Pushes do not register as 0-probability losses; Brier score reflects push neutrality.

- [x] **1.2 Push Neutrality in Sequential Quality Drift Detector (`src/swarm/feedback/conceptDriftDetector.ts`)**
  - **Location:** [`src/swarm/feedback/conceptDriftDetector.ts:78-109`](file:///c:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/feedback/conceptDriftDetector.ts#L78-L109)
  - **Issue:** Pushes passed as 0 quality trigger false Page-Hinkley downward quality drift alerts (`reset-policy`).
  - **Fix:** Support neutral 0.5 quality observations or explicit skip for push/void outcomes.
  - **Acceptance:** Push events do not trigger anomalous downward drift alerts against the baseline mean.

---

## Phase 2: Test Mock Verification & Contract Alignment
Eliminate legacy integer score mocks and fix schema field naming in test suites.

- [x] **2.1 Standardize Mock Critic Responses Across Engine Test Suites**
  - **Files:**
    - [`src/swarm/scheduler-engine.test.ts:34-36`](file:///c:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/scheduler-engine.test.ts#L34-L36): Change `computedRating: 92` to `0.92`, `criticFeedback` to `feedback`.
    - [`src/swarm/tieredCache-engine.test.ts:37-39`](file:///c:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/tieredCache-engine.test.ts#L37-L39): Change `computedRating: 95` to `0.95`, `criticFeedback` to `feedback`.
    - [`src/swarm/compression-engine.test.ts:41-43`](file:///c:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/compression-engine.test.ts#L41-L43): Change `computedRating: 94` to `0.94`, `criticFeedback` to `feedback`.
    - [`src/swarm/hierarchy-engine.test.ts:34-36`](file:///c:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/hierarchy-engine.test.ts#L34-L36): Change `computedRating: 94` to `0.94`, `criticFeedback` to `feedback`.
  - **Acceptance:** All engine test mocks comply with the `VerificationResult` schema; [`guardVerificationResult`](file:///c:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/parser/responseGuards.ts#L144) receives valid `feedback` strings.

---

## Phase 3: Time-Decayed Memory Retrieval in MemoryCortex
Prioritize recent market conditions, injury reports, and tactical changes over stale historical observations.

- [x] **3.1 Exponential Time-Decay in Candidate Ranking (`src/swarm/memory/tags.ts`)**
  - **Location:** [`src/swarm/memory/tags.ts:189-206`](file:///c:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/memory/tags.ts#L189-L206)
  - **Implementation:** In `rankAndFilterCandidates`, calculate recency factor:
    `recency = Math.pow(0.5, daysOld / halfLifeDays)` (default `halfLifeDays = 30`).
    `finalScore = c.vectorScore * weight * recency`.
  - **Exemption:** Graded facts/historical baseline axioms retain stable weight.
  - **Acceptance:** Stale judgments naturally decay in retrieval priority relative to current-season data.

---

## Phase 4: Domain-Specific Sparse Tokenizer & Betting Symbols
Prevent betting lines, odds, and spread symbols from being stripped or mangled during vector/BM25 tokenization.

- [x] **4.1 Preserve Betting Operators & Key Terms (`src/swarm/memory/tokenizer.ts`)**
  - **Location:** [`src/swarm/memory/tokenizer.ts:8`](file:///c:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/memory/tokenizer.ts#L8)
  - **Fix:** Update regex to preserve signed numbers and betting tokens: `/[+-]?\d+(?:\.\d+)?|[a-z0-9_\/]+/gi`.
  - **Acceptance:** Symbols like `+3.5`, `-110`, `O/U`, `ATS`, `ML`, `PK` are preserved as distinct searchable tokens.

- [x] **4.2 Deterministic Local Embedding Symbol Support (`src/swarm/memory/embeddings.ts`)**
  - **Location:** [`src/swarm/memory/embeddings.ts:65`](file:///c:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/memory/embeddings.ts#L65)
  - **Fix:** Align `DeterministicLocalEmbeddingProvider.computeVector` token extraction with betting symbol preservation.

- [x] **4.3 Semantic Similarity Normalization Tuning (`src/swarm/cache/semanticSimilarityEngine.ts`)**
  - **Location:** [`src/swarm/cache/semanticSimilarityEngine.ts:13-19`](file:///c:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/cache/semanticSimilarityEngine.ts#L13-L19)
  - **Fix:** Preserve `+`, `-`, `/` in `normalizeText` so line values are not stripped to plain numbers.

---

## Phase 5: Dynamic Divergence Gating (`no_play` Gate) in Executive Synthesis
Enforce bankroll protection by suppressing forced picks when specialists sharply diverge.

- [x] **5.1 Divergent Agreement Level Gating (`src/swarm/engine/consensusPipeline.ts`)**
  - **Location:** [`src/swarm/engine/consensusPipeline.ts:353-385`](file:///c:/Dev/Workspaces/The_Perfect_Swarm/src/swarm/engine/consensusPipeline.ts#L353-L385)
  - **Implementation:** In `renderPromptConsensusBlock`, when `digest.agreementLevel === 'divergent'`, inject explicit directive ordering the Manager to evaluate a `no_play` / `pass` rating if consensus confidence is below threshold (< 0.45).
  - **Acceptance:** When specialist disagreement is high, synthesis explicitly flags `no_play` rather than forcing low-conviction picks.

---

## Phase 6: Isolated Historical Backtesting & Simulation Harness
Provide a clean test harness for running historical slates through the swarm without polluting live Qdrant cortex or telemetry.

- [x] **6.1 Backtest Replay Route (`src/swarm/server/app.ts`)**
  - **Implementation:** Add `POST /api/swarm/backtest` endpoint accepting an array of historical slate games.
  - **Isolation:** Executes through `SwarmEngine` with `isolatedStore: true` and sandboxed in-memory memory cortex.
  - **Acceptance:** Full historical slates can be simulated and graded against closing lines without mutating live memory.

---

## Verification & Test Gate
1. `npm run lint` — Zero TypeScript diagnostics.
2. `npm run test:unit` — All unit suites pass with updated mocks.
3. `npm run build && node scripts/smoke-start.mjs` — Production bundle builds cleanly and smoke test passes.
