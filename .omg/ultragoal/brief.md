# Ultragoal Brief: Sports Betting Swarm Optimizations & Hardening

## Objective
Implement sports betting intelligence optimizations and hardening across `The_Perfect_Swarm` backend according to `todo.md`:
1. Push-Aware Quality Drift & Brier Hardening: Handle ties/pushes cleanly in `src/swarm/morning/feedback.ts` and `src/swarm/feedback/conceptDriftDetector.ts` without distorting Brier scores or triggering false Page-Hinkley quality drift alarms.
2. Test Mock Verification & Contract Alignment: Standardize critic test mocks across engine suites (`computedRating: 0.9X`, `feedback: string`).
3. Time-Decayed Memory Retrieval: Exponential recency decay `Math.pow(0.5, daysOld / halfLifeDays)` in `src/swarm/memory/tags.ts` for judgments while retaining stable weight for axioms/facts.
4. Domain-Specific Sparse Tokenizer & Betting Symbols: Preserve signed lines (`+3.5`, `-110`) and operators (`O/U`, `ATS`, `ML`, `PK`) across `tokenizer.ts`, `embeddings.ts`, and `semanticSimilarityEngine.ts`.
5. Dynamic Divergence Gating: Inject `no_play` / `pass` directive in `src/swarm/engine/consensusPipeline.ts` when consensus is divergent and confidence < 0.45.
6. Isolated Historical Backtesting: Implement `POST /api/swarm/backtest` in `src/swarm/server/app.ts` with sandboxed in-memory cortex (`isolatedStore: true`).
7. Complete Test & Lint Verification: Ensure zero TypeScript errors and all unit tests pass cleanly.
