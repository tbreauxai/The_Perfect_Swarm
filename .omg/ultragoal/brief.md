# Ultragoal Brief: Modularization and Deduplication in Server App

**Objective:** Implement the deduplication and modularization plan detailed in `todo.md` for `src/swarm/server/app.ts`.

## Core Objectives
1. **Agent Sanitization Helper:** Extract `sanitizeAgent` out of `sanitizeClientSettings` into a standalone, exported helper function. Replace all 4 duplicated inline agent sanitization loops across `/api/swarm/stream`, `/api/swarm/analyze`, and `/api/swarm/backtest`.
2. **Environment Resolution Helper:** Extract `resolveEnvironment(c)` to eliminate 5 duplicated `Object.assign({}, typeof process !== 'undefined' ? process.env : {}, c.env || {})` expressions.
3. **Edge Settings Builder:** Extract `buildEdgeSettings(env)` to eliminate 3 duplicated edge settings object literal declarations.
4. **App ID Resolution:** Extract `resolveAppIds(c, defaultSettings)` to eliminate 3 duplicated `callerAppId` / `serverDefaultAppId` / `originApp` calculations.
5. **Outcome Hydration Helper:** Extract `hydrateAppOutcomes(originApp, limit)` to encapsulate knowledge repository query and hydration logic.
6. **Serialization & Safe Fallback Helper:** Extract `serializeSwarmResult(c, result)` and `buildSafeFallback(result, err)` to eliminate duplicated JSON serialization and circular reference recovery logic.
7. **Verification Gate:** Pass `npm run lint`, all unit tests (`npm run test:unit`), and production smoke start (`node scripts/smoke-start.mjs`).
