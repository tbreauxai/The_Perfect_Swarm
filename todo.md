Fix two remaining issues exposed by workflow `wf-1795793610622`:

1. **Prevent Blanket / Uncited Risk Critic Vetoes:**
   - In the Risk Critic prompt/contract:
     - Explicitly clarify that `Steam: neutral (0 pts)` and `Divergence: single_book` are valid market movement results — NEVER treat them as "missing market data".
     - Require that any `verdict: "veto"` MUST cite specific `row` ID(s) and the exact contradictory tool field for each vetoed leg. A veto with zero cited legs/violations is invalid; if one proposer's legs have an issue and the other proposer's legs are clean, approve the clean legs instead of issuing a blanket slate veto.
   - In the Critic post-processor / compiler handoff: if the Critic outputs `"No fatal ..."` or returns `verdict: "veto"` with zero specific leg vetoes (`vetoedLegs.length === 0`) and no deterministic verifier failures, log a warning and do not let an uncited blanket veto nuke grounded proposer picks.

2. **Diagnose & Fix `HybridCortex` `recordsFound: 0` on `pwa_swarm_dev_cortex_v4`:**
   - Inspect `HybridCortex` query construction, Qdrant `filter` payload keys, and `score_threshold` / `scoreThreshold`.
   - Compare the live filter keys against the exact payload schema written by the `cortex_lessons_backfill` script (`appId`, `domain`, etc.).
   - When the user prompt is generic (e.g., `"what's the best 3 leg parlay to place today?"`), enrich the Cortex search query with the active `domains` (e.g., `ncaaf nhl parlay spread moneyline`) so dense/sparse retrieval matches stored lessons instead of falling below the score threshold.

Add unit tests for both fixes, run typecheck and vitest, and report the exact root cause of `recordsFound: 0` along with the diff.