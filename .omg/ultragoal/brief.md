# Ultragoal Brief: Fix 3 - Server-Only Provider Secrets & Client Key Decontamination

## Objective
Enforce that provider and Qdrant keys originate exclusively from server secrets. The browser must never collect, persist, or forward LLM provider keys or vector database credentials.

## Constraints & Architectural Boundaries
- Do NOT change caller auth (`createAppAuthMiddleware`, `authHeaders`, `SWARM_APP_TOKENS`).
- Do NOT change CORS allowed origins behavior (keep trusted origins, `Vary: Origin`, 403 on disallowed preflight).
- Do NOT change shared memory or app tokens (`appId`, `swarm_app_token`).
- Do NOT delete `appId`, agents' `role`, `provider`, or `model` when sanitizing payloads.
- Zero conversational filler; concise commentary under 10 words.

## Key Changes
1. **Server Ignores Client Provider Secrets**:
   Before executing stream or analyze (`src/swarm/server/app.ts`), delete `geminiApiKey`, `openRouterApiKey`, `groqApiKey`, `mistralApiKey`, `githubToken`, `qdrantUrl`, `qdrantApiKey`, `apiKey` from body settings and from each agent. Server env values win.
2. **Model Listing Uses Server Secrets Only**:
   Ignore `x-provider-key`. Remove it from `Access-Control-Allow-Headers`. `/api/swarm/models` uses server secrets and retains app bearer token requirement.
3. **No Direct Browser Calls to Providers**:
   Remove client fetches to `api.groq.com`, `openrouter.ai`, `generativelanguage.googleapis.com`, `api.mistral.ai`, and `models.inference.ai.azure.com`. Health checks and model listings route through `/api/swarm/models` and existing backend `/api/health`.
4. **Default Ephemeral Mode & LocalStorage Sanitization**:
   New settings default to `ephemeralKeys: true`. On load, strip any persisted provider keys from `swarm_settings` and rewrite cleaned JSON back. Ensure App token stays in `swarm_app_token` and is not stored in `swarm_settings`.
5. **Remove Provider Key Inputs**:
   Remove Gemini, OpenRouter, Groq, Mistral, Qdrant URL, Qdrant key, and GitHub token input fields from `SettingsModal.tsx`. Keep App namespace (`appId`) and App token (`appToken`). Status badges continue to display server secrets status.
