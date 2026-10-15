# Ultragoal Brief: OpenRouter Instant Model Swap

## Objective
Swap retired OpenRouter instant model (`meta-llama/llama-3.3-70b-instruct:free` -> `nvidia/nemotron-3-super-120b-a12b:free`) across 6 discrete steps:
- Step 1: `src/swarm/router.ts` (update OpenRouter instant recommendation to nvidia/nemotron-3-super-120b-a12b:free)
- Step 2: `src/swarm/router.test.ts` (update unit test expectation)
- Step 3: `src/swarm/router-lifecycle.test.ts` (update lifecycle test expectation)
- Step 4: `src/swarm/server/modelsProvider.warn.test.ts` (add test for live list recognition)
- Step 5: `test-multi-app-simulation.ts` (cosmetic fixture updates at L232 and L490)
- Step 6: `README.md` (documentation update)

## Status
- All 6 steps completed and verified
- PR #89 created and squashed into main (`aa7e28c`)
