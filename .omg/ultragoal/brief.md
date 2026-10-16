# Ultragoal Brief: Strict Judge Output Validation & Manager Schema Enforcement

## Objective
Fix false positive 50%/0 default judgments in the morning slate engine across three modules:
1. `src/swarm/morning/judgePrompt.ts`: Stop defaulting missing fields. Validate that `winProbHome` is a number in `0.01–0.99` and `fairSpread` is a valid number. Return `null` if missing. Inspect objects (`finalAnalysis`, `result`, `judgment`, components, fenced code blocks) before falling back. Mark judgments with `isExplicit: true`.
2. `src/swarm/morning/supabase.ts`: Refuse to write rows with `win_prob_home: 0.5` and `fair_spread: 0` unless explicitly returned by the judge (`isExplicit: true`). Prevent missing judgments from overwriting real rows.
3. `src/swarm/morning/index.ts`: Pass manager instruction & judge schema in `settings` so GodView Compiler emits raw judge JSON. If `parseAndValidateJudgeOutput` returns `null`, push `{ eventId, error: "judge output missing winProbHome or fairSpread" }`, skip upsert, leave existing row, and do not increment `judged` or `replaced` counters.
4. Support in engine synthesis (`src/swarm/engine/synthesisPipeline.ts` & `verificationPipeline.ts`) to honor custom manager instruction and preserve judge output objects.
