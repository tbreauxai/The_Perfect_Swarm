# Ultragoal Brief: Default Agent List & Provider Key Guard for Morning Slate

## Objective
Prevent "No active Analysts found" failures in `runMorningSlate` (`POST /api/swarm/morning`) by dynamically building `settings.agents` from present environment API keys (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`) matching the DuelOdds pregame topology:
1. `a1`: Quant Proposer (`gemini`, `gemini-3.1-flash-lite`) if `GEMINI_API_KEY` is present.
2. `a2`: Market Proposer (`groq`, `openai/gpt-oss-120b`) if `GROQ_API_KEY` is present.
3. `critic`: Risk Critic (`openrouter`, `nvidia/nemotron-3-ultra-550b-a55b:free`) if `OPENROUTER_API_KEY` is present.
4. `manager`: GodView Compiler (`groq`, `openai/gpt-oss-120b`) if `GROQ_API_KEY` is present.

## Guard & Fail-Fast Behavior
- If none of `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` are present, return immediately with one error in `errors` and do not loop the slate.
- No direct-judge fallback.
- Preserve `originApp: 'duelodds'` and `callerAppId: 'duelodds'` for calibration.
- Preserve route signature: `POST /api/swarm/morning` takes `{ date? }` and returns `{ ok, gameDate, judged, replaced, skipped, snapshots, errors }`.
