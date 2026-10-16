The Perfect Swarm
The morning route is live and the worker is calling it. The run fails on every game with No active Analysts found. runMorningSlate in src/swarm/morning/index.ts passes API keys to executeSwarmWorkflow but no settings.agents. The engine requires at least one analyst. A normal DuelOdds analyze sends agents. This path does not.

- [x] In src/swarm/morning/index.ts, build a default agent list from the env keys and pass it as settings.agents. Use the same pregame topology DuelOdds uses:
  - [x] a1: Quant Proposer (gemini, gemini-3.1-flash-lite) if GEMINI_API_KEY is present
  - [x] a2: Market Proposer (groq, openai/gpt-oss-120b) if GROQ_API_KEY is present
  - [x] critic: Risk Critic (openrouter, nvidia/nemotron-3-ultra-550b-a55b:free) if OPENROUTER_API_KEY is present
  - [x] manager: GodView Compiler (groq, openai/gpt-oss-120b) if GROQ_API_KEY is present
- [x] Only include an agent if its provider key is present: GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY.
- [x] If none of those keys exist, return one error and do not loop the slate. Do not add a direct-judge fallback.
- [x] Also set originApp: 'duelodds' and callerAppId: 'duelodds' so calibration stays on the DuelOdds app.
- [x] Do not change the route shape. POST /api/swarm/morning still takes { date? } and returns { ok, gameDate, judged, replaced, skipped, snapshots, errors }.
