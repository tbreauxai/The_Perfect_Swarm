# Swarm Intelligence, Quantitative Prediction & Rate-Limit-Safe Scale Upgrade

This upgrade equips **The Perfect Swarm** with a deterministic pre-aggregation and anomaly-sketching layer, provider-aware adaptive chunk sharding, pre-execution mathematical grounding (including Holt-Winters, autocorrelation, Kelly criterion, and Monte Carlo bootstrap tools), citation-verified consensus arbitration, and a Brier-calibrated Bayesian/log-odds prediction ensemble—all surfaced with interactive controls and live telemetry in the Swarm Debugger UI.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following architectural and feature choices were confirmed during our clarification step and govern this implementation:

- **Confirmed Decision 1 — Rate-Limit-Safe Large Data Ingestion**: Implement both the **Pre-Aggregation Sketcher & Anomaly Extractor** (collapsing massive tabular/JSON datasets into exact statistical digests + top z-score outlier rows before LLM invocation) and **Provider-Aware Adaptive Chunk Sharding** (sizing chunks dynamically per seat's real TPM/input token ceiling so tight-quota seats like Groq and Mistral never suffer mid-chunk truncation or 429 bursts).
- **Confirmed Decision 2 — Intelligence, Analysis & Prediction Capabilities**: Implement all four quantitative intelligence upgrades:
  1. **Pre-Execution Deterministic Math Grounding**: Run statistical, time-series, and probability tools deterministically during profiling and inject verified ground-truth anchors into Analyst, Manager, and Critic prompts before LLM reasoning begins.
  2. **Quantitative Forecasting & Monte Carlo Tool Suite**: Expand the built-in zero-dependency tool engine with Holt-Winters exponential smoothing, lag-1/lag-k autocorrelation & structural break detection, Kelly criterion / EV edge sizing, and Monte Carlo bootstrap confidence intervals.
  3. **Evidence-Weighted & Citation-Verified Consensus Scoring**: Upgrade cross-analyst consensus to weight findings by row-ID/metric citation density, deterministic tool corroboration, and historical seat reliability rather than word overlap alone.
  4. **Brier-Weighted Bayesian & Log-Odds Pooling**: Aggregate numeric probabilities (`winProbHome`, `edge`, `confidence`) across specialist seats using extremized log-odds pooling weighted by each seat's rolling Brier calibration score in `MemoryCortex`.
- **Confirmed Decision 3 — Full-Stack Scope (Engine + Live UI Telemetry & Controls)**: Expose interactive toggles and live telemetry cards in the Swarm Debugger UI so users can configure pre-aggregation/forecasting modes and inspect sketch digests, provider shard allocations, deterministic ground-truth anchors, and calibrated ensemble probabilities in real time.

> [!NOTE]
> **Strict Zero-Ban & User Model Policy Preserved**: In accordance with project architectural rules, no model blacklists or overrides will be introduced. Every user-configured seat and model executes strictly as configured.

---

## 1. Overview & Core Concept

- **What It Does**: Transforms how the Swarm ingests high-volume datasets and synthesizes predictions. Instead of blindly slicing 50,000+ rows into dozens of raw 8,000-token chunks that exhaust free-tier TPM/RPM budgets or get truncated at 1,500 tokens on Groq, the engine first builds a deterministic **Columnar Statistical Sketch & Anomaly Digest** and shards remaining partitions to match each assigned seat's exact token budget. Before seats run, deterministic forecasting and probability math is computed and injected as ground truth. After seats finish, an **Evidence-Weighted Consensus & Bayesian Log-Odds Pooler** combines qualitative insights and numeric probabilities into a calibrated executive synthesis.
- **Target Audience / Persona**: Data engineers, quantitative analysts, and developers running complex multi-agent analysis and forecasting workloads across free-tier LLM providers (Gemini, Groq, Mistral, OpenRouter, NVIDIA, Cloudflare).
- **Key Value**:
  - **80–95% Fewer LLM Calls on Large Datasets**: 50k-row CSV/JSON payloads are summarized into exact distribution sketches + high-z-score anomaly rows before hitting rate-limited seats.
  - **Zero Mid-Chunk Truncation**: Tight-budget seats (Groq 1.5k input cap, Mistral 2k input cap) receive compact, self-contained shards tailored to their exact input window.
  - **Hallucination-Proof Quantitative Predictions**: Analysts reason over pre-verified math anchors (trend slopes, Holt-Winters forecasts, Monte Carlo intervals, implied probabilities), and final probabilities are mathematically pooled using Brier-calibrated log-odds.

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Ingestion & Strategy Configuration**: In the left-hand Input & Strategy panel (and Settings modal), the user can toggle **Pre-Aggregation Sketching**, **Provider-Aware Sharding**, and **Deterministic Math Grounding**, and load large CSV/JSON payloads (raised to support multi-megabyte pastes/uploads in the UI).
  2. **Live Execution Trace Inspection**: As the workflow streams SSE events, the timeline renders dedicated expandable inspection views for:
     - **Columnar Sketch & Anomaly Digest**: Shows total rows scanned, compression ratio, per-column quantile/outlier stats, and extracted high-leverage anomaly rows (`R1..Rn`).
     - **Provider-Aware Adaptive Sharding**: Displays how chunks were sized per specialist seat and provider ceiling (`1,500` tokens for Groq, `2,000` for Mistral, `8,000` for Gemini) with zero truncation loss.
     - **Deterministic Ground-Truth Anchors**: Lists pre-computed statistical and forecasting outputs (Holt-Winters projection, autocorrelation regime, Kelly edge, Monte Carlo 95% CI) injected into the seats.
     - **Evidence-Weighted Consensus & Bayesian Ensemble**: Displays citation-verified agreement scores, per-seat Brier calibration weights, and the pooled log-odds probability vs. raw uncalibrated mean.
  3. **Executive Synthesis Dashboard**: Renders the final generative UI alongside a structured **Quantitative Calibration & Ensemble Summary** strip when numeric predictions or scorecards are active.

- **Visual Identity & Theme**:
  - *Aesthetic Direction*: High-density, utilitarian developer & quantitative analytics console (following SaaS & Dashboard architectural rules).
  - *Color Palette & Mood*: Crisp neutral slate canvas (`bg-neutral-50`, `#FFFFFF` structural surfaces, `border-neutral-200` 1px hairlines) with focused indigo (`#4F46E5`) primary interactive accents and semantic status pairing (`#16A34A` nominal/verified, `#D97706` anomaly/warning, `#DC2626` error/degraded—always paired with explicit text labels, never color alone).
  - *Typography & Hierarchy*: Clean sans-serif structural hierarchy paired with strict tabular monospace numerals (`font-mono tabular-nums`) for all token counts, quantiles, z-scores, Brier weights, probabilities, and latencies to guarantee vertical decimal alignment.
  - *Component Styling & Layout*: Single-elevation flat cards with 1px hairline borders; zero nested card sandwiches; unboxed inline metadata separated by middots (`·`); single-line control labels (`whitespace-nowrap shrink-0`).

- **Interactive Feedback & Motion**:
  - Instant (<150ms) expand/collapse transitions on trace nodes, live client-side filtering of timeline events by pipeline stage (`All`, `Ingestion & Sharding`, `Math Grounding`, `Specialists`, `Consensus & Ensemble`), and responsive progress indicators during multi-wave execution.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Pre-Aggregation Columnar Sketching + Top-Anomaly Row Extraction vs. Raw Multi-Chunk Flooding**
  - *Chosen Approach*: When a structured CSV, JSON array, or log dataset exceeds single-pass provider limits, run a zero-LLM single-pass streaming profiler that computes exact per-column distributions (mean, SD, median/IQR, min/max, missingness, top-K categorical frequencies, linear/Holt-Winters trend) and extracts the top $N$ statistically anomalous rows ($|z| > 2.5$ or IQR outliers) plus stratified boundary samples with canonical `R1..Rn` row IDs.
  - *Why*: Free-tier providers (especially Groq at 7,000 TPM and Mistral at 2 RPM) cannot process 100+ raw chunks without hitting 429 circuit breakers. Pre-aggregating 100% of the rows deterministically in TypeScript preserves global statistical accuracy while keeping the LLM payload within 1–3 high-signal shards.
  - *Alternatives Considered*: Uniformly dropping middle chunks (loses interior anomalies) or relying solely on LLM map-reduce over 100+ chunks (fails free-tier rate limits).

- **Decision 2: Provider-Aware Adaptive Sharding vs. Fixed 8,000-Token Chunks**
  - *Chosen Approach*: Replace uniform 8,000-token chunking with a provider-budget-aware sharder that inspects the active specialist seats' `PROVIDER_LIMITS` (`maxInputTokens` minus prompt overhead) and constructs seat-tailored shards—routing compact statistical digests and tight row batches to Groq/Mistral seats while routing wider raw context partitions to high-ceiling Gemini/OpenRouter seats.
  - *Why*: Eliminates the silent ~75% tail truncation that previously occurred when an 8,000-token chunk was passed into `fitChunkToProvider` for a 1,500-token Groq seat.

- **Decision 3: Pre-Execution Deterministic Math Grounding vs. Post-Hoc Tool Parsing**
  - *Chosen Approach*: Automatically detect numeric series, odds/probabilities, and tabular columns during Stage 1 profiling, execute the deterministic quantitative tool suite *before* specialist prompts are dispatched, and inject a `[Verified Deterministic Math Anchors]` block into Analyst, Critic, and Manager prompts (while retaining post-response tool execution for any additional ad-hoc tool calls).
  - *Why*: Small and fast free-tier models frequently make arithmetic errors on standard deviations, implied probabilities, or multi-period trend projections. Giving them pre-computed deterministic math lets them focus 100% of their reasoning budget on domain interpretation and causal analysis.

- **Decision 4: Brier-Calibrated Log-Odds Pooling & Citation-Weighted Consensus**
  - *Chosen Approach*: Combine numeric seat predictions (`winProbHome`, `confidence`, `edge`) in log-odds space weighted by each seat's historical Brier skill score (tracked in `MemoryCortex` and `SpecialistProfiler`) with an extremizing factor $k \in [1.0, 1.35]$ when independent cross-provider agreement is high. Simultaneously score qualitative findings by counting verified data citations (`R\d+` row references and numeric matches against the raw data/sketch).
  - *Why*: Simple linear averaging of LLM probabilities is under-confident and treats a hallucinating seat equally with a well-calibrated seat that cites concrete row evidence.

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

### Architecture & Component Diagram

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                        Swarm Debugger UI (React + Tailwind)                       │
│  ┌─────────────────────────┐  ┌─────────────────────────┐  ┌───────────────────┐  │
│  │ Input & Strategy Panel  │  │ Execution Trace Stream  │  │ Executive &       │  │
│  │ • Large Payload Input   │  │ • Stage Filter Bar      │  │ Ensemble Viewer   │  │
│  │ • Sketch / Shard Toggles│  │ • Sketch & Shard Cards  │  │ • Calibrated Pool │  │
│  │ • Math Grounding Toggle │  │ • Math & Consensus View │  │ • Generative UI   │  │
│  └────────────┬────────────┘  └────────────▲────────────┘  └─────────▲─────────┘  │
└───────────────┼────────────────────────────┼─────────────────────────┼────────────┘
                │ POST /api/swarm/stream     │ SSE Events & Stages     │
┌───────────────▼────────────────────────────┴─────────────────────────┴────────────┐
│                         Swarm Engine Pipeline (TypeScript)                        │
│                                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐  │
│  │ Stage 1: Deterministic Ingestion, Sketching & Provider-Aware Sharding       │  │
│  │ • Columnar Sketcher (Quantiles, Z-Score Outliers, Correlations, Group-Bys)  │  │
│  │ • Adaptive Chunk Sharder (Tailored to Groq 1.5k / Mistral 2k / Gemini 8k)   │  │
│  └──────────────────────────────────────┬──────────────────────────────────────┘  │
│                                         ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────┐  │
│  │ Stage 2: Pre-Execution Quantitative & Forecasting Grounding                 │  │
│  │ • Holt-Winters Smoothing • Lag Autocorrelation & Regime Break Detector      │  │
│  │ • Kelly / Implied EV Edge • Monte Carlo Bootstrap CI (1,000 resamples)      │  │
│  └──────────────────────────────────────┬──────────────────────────────────────┘  │
│                                         ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────┐  │
│  │ Stage 3: Paced Multi-Seat Specialist Execution                              │  │
│  │ • Seat Staggering + Provider Token-Bucket Limiter + Shard-Matched Prompts   │  │
│  └──────────────────────────────────────┬──────────────────────────────────────┘  │
│                                         ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────┐  │
│  │ Stage 4: Evidence-Weighted Consensus & Brier-Calibrated Log-Odds Ensemble   │  │
│  │ • Citation & Tool Corroboration Scorer (Row IDs + Ground-Truth Alignment)   │  │
│  │ • Extremized Log-Odds Pooler Weighted by Rolling Seat Brier Calibration     │  │
│  └──────────────────────────────────────┬──────────────────────────────────────┘  │
│                                         ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────┐  │
│  │ Stage 5: Cross-Provider Critic Verification & Executive Manager Synthesis   │  │
│  └─────────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Data Model & State

- **`DatasetSketch` & `ColumnSketch`**:
  - `rowCount`, `columnCount`, `format`, `compressionRatio`, `tokensSaved`.
  - Per-column metrics: `name`, `type` (`numeric` | `categorical` | `temporal`), `count`, `missingCount`, `mean`, `stdDev`, `min`, `p25`, `median`, `p75`, `max`, `skewness`, `trendSlope`, `topCategories`.
  - `correlations`: Top pairwise Pearson correlations ($|r| \ge 0.4$) across numeric columns.
  - `anomalyRows`: Top outlier rows with canonical `R<rowNumber>` IDs, max $|z|$-score, and triggering columns.
  - `stratifiedSample`: Head, median-stratum, and tail representative rows.
- **`AdaptiveShardPlan`**:
  - Maps each active specialist seat (`agentId`, `provider`, `maxInputTokens`) to tailored chunk shards (`digestShard` for tight-TPM seats vs. `partitionShards` for high-context seats) with zero post-hoc truncation.
- **`QuantitativeGroundingReport`**:
  - Deterministic pre-execution outputs from the forecasting and statistical tool suite (`holtWintersForecast`, `autocorrelationRegime`, `monteCarloConfidenceInterval`, `kellyEdgeMetrics`, `columnStats`), formatted as a compact prompt anchor block and emitted as a structured trace event.
- **`CalibratedEnsembleDigest` (extending `AnalystConsensusDigest`)**:
  - `evidenceWeightedScore`: Consensus score weighted by verified `R\d+` row citations, numeric grounding matches, and historical seat accuracy.
  - `citationCountsBySeat`: Map of specialist roles to verified citation counts.
  - `pooledProbability`: Brier-weighted extremized log-odds probability (`pooledWinProb`, `rawMeanProb`, `confidenceInterval95`, `ensembleEdge`, `brierWeightsBySeat`).

### Interactive Component & State Mapping

- **Input & Strategy Controls (`App.tsx` & `SettingsModal.tsx`)**:
  - Raise client-side `MAX_DATA_CHARS` ceiling from `500,000` to `5,000,000` characters so large CSV/JSON datasets supported by the 10MB server limit can be pasted or loaded directly in the browser without client-side blocking, plus a quick **"Load Sample High-Volume Dataset"** action for one-click testing.
  - Add interactive toggles for **Pre-Aggregation Sketcher**, **Provider-Aware Sharding**, and **Deterministic Math Grounding** bound directly to `settings.optimizationSettings` and persisted in `useSwarmSettings`.
- **Execution Trace Stage Filter & Rich Cards (`SwarmEventTimeline.tsx`)**:
  - Add a single-line segmented filter bar above the timeline (`All Events`, `Data Sketch & Shards`, `Math & Forecasting`, `Specialists`, `Consensus & Ensemble`) that filters visible trace events client-side.
  - Render dedicated tabular inspection views inside expanded trace cards for `Columnar Data Sketching`, `Provider-Aware Adaptive Sharding`, `Deterministic Math Grounding`, and `Cross-Analyst Consensus Synthesized`.
- **Ensemble & Calibration Summary (`AnalysisViewer.tsx`)**:
  - When `finalAnalysis` or `consensus` includes calibrated ensemble metrics or citation-weighted arbitration, render a clean single-elevation summary strip displaying the pooled probability, 95% Monte Carlo confidence band, citation verification rate, and token savings achieved by pre-aggregation.
