# Ultragoal Brief: Critic JSON Seats, Per-Game Analyst Tools, Drop Uncovered Picks

## Objective
Fix Groq 400 `tool_use_failed` caused by seats requiring strict JSON (such as critic / risk / risk_critic) calling an invented tool named 'json'. Run role tools for each game on the slate (in parsedHeaders order) bounded by existing seat budget caps, recording `coveredEventIds`. Drop any proposer/manager/scorecard picks for games that lack analyst coverage.

## Scope & Constraints
- Base: `2878b9e8` (Swarm `main` after PR #155).
- Branch: `fix/critic-analyst-scope`.
- Prep only: no deploy, no prod SQL/db push, no live LLM or provider calls, no secrets in code/logs, no migration.
- Node 22 strip-only TS (no param properties, enums, namespaces, import=require, decorators).
- Prompts stay small by design: do not raise caps; no raw board. Stay inside existing `seatBudget(provider)` caps (`maxToolCalls`: Groq 6, others 8; `maxToolResultChars`: Groq 2000, others 6000; `maxPromptChars`: Groq 5600; `renderHeaders`: 1600 chars).
- Push only to feature branch `fix/critic-analyst-scope`; open PR with mandatory line `"NEVER push to main; push only the feature branch"`. No merge between 9:00 - 10:00 PM CT.
