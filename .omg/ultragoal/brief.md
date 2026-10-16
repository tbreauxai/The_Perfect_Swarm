# Ultragoal Brief: Groq Token Optimization, Single-Seat Constraint & Prompt Sizing

## Objective
Prevent Groq 8,801 TPM rate limit errors and 413 payload errors across Swarm execution by:
1. `src/swarm/providers/groq.ts`:
   - Stop sending `max_tokens: 8192`.
   - Default to 1024 for analyst and critic calls, 2048 for the manager.
   - Clamp `maxTokens` so `estimatedPromptTokens + maxTokens` stays under 6,000. Never allow a single call to reserve the entire 8,000 TPM budget.
   - Cap the text string sent to Groq at 6,000 characters (preserving core task and baselines).
2. `src/swarm/morning/index.ts` and DuelOdds Agent List:
   - Ensure strictly one Groq seat: Market Proposer on `openai/gpt-oss-120b`.
   - GodView Compiler on `mistral-small-latest`.
   - Prohibit assigning any second agent to `gpt-oss-120b` or `gpt-oss-20b` (shared 8,000 TPM budget).
3. Prompt Construction & Separation:
   - Do not send the full pick JSON schema contract to every agent.
   - Proposers receive the board and baseline; the manager receives the JSON contract.
   - Keep morning baselines; truncate secondary fluff (alternate markets, old news) when capping.
4. Verification & Validation:
   - Unit tests in `src/swarm/providers/groq.test.ts` and `src/swarm/server/morning.test.ts`.
   - Full test suite, TypeScript typecheck (`tsc --noEmit`), and bundle build pass cleanly.
