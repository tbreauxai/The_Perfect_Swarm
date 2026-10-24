# Ultragoal Brief: Morning Judge Cross-Check (DuelOdds Live Test Bug 1, Swarm S1-S4)

## Objective
Implement morning judge cross-checking to prevent incoherent AI judgments (conflicting fairSpread vs winProbHome vs likelyWinner, out-of-bounds sport totals, or extreme deviation from market lines) from being written to the database.

## Architecture & Boundary Invariants
1. **Branch**: `fix/judge-crosscheck` from `main` (31f9aaa).
2. **Rejection Semantics**: Incoherent judgments log `[MorningJudge] Rejected judgment for AWAY @ HOME: <reason>` and return `null`.
3. **Downstream Safety**: Nothing written on rejection (no half-written games). Errors recorded and execution continues to next game.
4. **No Fallback / Retry**: By design, no direct-judge fallback or retry loop; unjudged game stays claimed for `MORNING_CLAIM_TTL_MS` (20 min) and is re-judged on subsequent run.
5. **Strip-Types Compatibility**: Node 22 `--experimental-strip-types` erasable syntax only (no enums, namespaces, parameter properties).
6. **No Network in Tests**: Injected mocks for `fetch` and `executeWorkflowFn`.

## Modules & Steps
- **Step 1 (SM)**: Branch creation & shared startup smoke check (empty commit `step 1`).
- **Step 2 (JP)**: Cross-check helpers: `JUDGE_TOTAL_RANGES`, `JUDGE_MARKET_CAPS`, `JudgeMarketLines`, `crossCheckJudgeOutput` in `src/swarm/morning/judgePrompt.ts` (commit `step 2`).
- **Step 3 (JP)**: Parser rejection wiring: `parseAndValidateJudgeOutput` receives `market`, tracks `namedWinner`, checks sport total range, executes cross-check (commit `step 3`).
- **Step 4 (JP)**: Prompt tuning: NCAAF (30-80) / NCAAB (110-180) ranges added, 215.5 NBA total replaced with null in examples (commit `step 4`).
- **Step 5 (DS)**: Downstream market wiring: `runMorningSlate` passes odds snapshot lines, updates rejection error text, updates fixtures in `morning.test.ts` and `morningCacheBypass.test.ts` (commit `step 5`).
- **Step 6 (DS)**: New test suite `src/swarm/server/judgeCrossCheck.test.ts` & full final verification (commit `step 6`).
