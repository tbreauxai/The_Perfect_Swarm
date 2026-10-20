# Ultragoal Brief: Fix Model List & Live Probing System

## Objective
Fix the model list system in `The_Perfect_Swarm` so that it reliably probes for live models and returns a catalog of working models available for use:
1. Ensure `DEFAULT_PROVIDER_MODELS` and free models (`:free`) are prioritized in `rankModelsForAccount` so probes never fail exclusively on inaccessible paid models (e.g. OpenRouter).
2. Prevent empty catalogs (`[]`) when providers return rate limits or on cold cache: retain working baseline models with appropriate availability flags.
3. Optimize probe latency and warm cache on boot in `app.ts` so `/api/swarm/models` responds fast and never times out callers.
4. Support all active providers (`nvidia`, `cloudflare`, `groq`, `gemini`, `mistral`, `openrouter`) in `src/services/providerService.ts` and `AgentConfigurator.tsx`, removing retired `github`.
5. Comprehensive unit test coverage asserting live probing, ranking, fallback retention, and client service integration.
