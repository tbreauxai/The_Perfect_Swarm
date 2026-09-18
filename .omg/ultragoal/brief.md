# Ultragoal Brief: Token-Aware Prompt Compression Using Semantic Deduplication

## Objective
Adopt token-aware prompt compression using semantic deduplication to cut context costs by 30-50% across multi-agent workflows, specialist task dispatches, and manager synthesis without sacrificing critical domain constraints or reasoning fidelity.

## Background & Problem Statement
In multi-agent swarm workflows, large context windows rapidly accumulate redundant data:
1. Multiple specialists inspect overlapping data chunks or raw inputs and generate reports containing duplicate findings, verbatim restatements of historical baselines, and boilerplate phrasing.
2. Step 5 (Manager Synthesis & Critic Verification) bundles all raw analyst reports and memory baselines into a single monolithic prompt, consuming substantial context tokens and incurring latency and API costs.
3. Repetitive context across parallel analyst calls inflates token budgets without adding net-new semantic information.

## Architecture Boundaries
1. **Prompt Compression Engine (`src/swarm/compression.ts`)**:
   - `TokenAwarePromptCompressor`: Heuristic token estimation, priority-weighted segment pruning, and target reduction enforcement (30-50%).
   - `SemanticDeduplicator`: N-gram / Jaccard / Cosine term frequency semantic similarity scoring to identify and consolidate overlapping statements across reports and baselines.
   - Information Preservation: Protect high-priority directives (task goals, schema constraints, quantitative anomalies, critical alerts) while collapsing redundant verbiage and duplicate exemplar text.
2. **Swarm Engine Integration (`src/swarm/engine.ts` & `src/swarm/types.ts`)**:
   - Add `SwarmCompressionSettings` to `SwarmEngineSettings`.
   - Apply token-aware prompt compression to analyst prompts (Step 4), manager synthesis dynamic prompts (Step 5), and critic verification inputs.
   - Emit `Prompt Compressed` context telemetry events with original tokens, compressed tokens, and reduction ratio.
   - Aggregate saved tokens in metrics telemetry.
3. **Distribution & Backward Compatibility**:
   - Zero external runtime dependencies (pure TypeScript algorithmic compression).
   - Subpath export `@perfect-swarm/core/compression`.
   - Dual ESM/CJS distribution bundles.
   - 100% passing Vitest suites and all 5 E2E test scripts.
