# Server App Modularization & Deduplication Plan

**Status:** Completed  
**PR:** [#124](https://github.com/tbreauxai/The_Perfect_Swarm/pull/124)  
**Merged SHA:** `b1a9e6d37a74b2be73ba34e87c71d6b4c5217d71`

---

## Completed Tasks

- [x] **0. Agent Sanitization Helper Extraction**
  - Extracted `sanitizeAgent` out of `sanitizeClientSettings` into a standalone, exported helper function.
  - Replaced all 4 duplicated inline agent sanitization loops across `/api/swarm/stream`, `/api/swarm/analyze`, and `/api/swarm/backtest` with `body.agents.map(sanitizeAgent)`.

- [x] **1. Environment Variables Resolution Helper**
  - Extracted `resolveEnvironment(c)` pure helper function.
  - Replaced 5 duplicated `Object.assign({}, typeof process !== 'undefined' ? process.env : {}, c.env || {})` invocations across all routes.

- [x] **2. Edge Settings Construction Helper**
  - Extracted `buildEdgeSettings(env)` function.
  - Replaced 3 duplicated edgeSettings object literal declarations across stream, analyze, and backtest routes.

- [x] **3. App ID Resolution Helper**
  - Extracted `resolveAppIds(c, defaultSettings)` function returning `{ callerAppId, originApp }`.
  - Replaced 3 duplicated ID resolution blocks across stream, analyze, and backtest routes.

- [x] **4. Outcome Records Hydration Helper**
  - Extracted `hydrateAppOutcomes(originApp, limit)` function.
  - Replaced 3 long, duplicated knowledge repository query and hydration invocations.

- [x] **5. JSON Serialization Fallback Logic Helper**
  - Extracted `serializeSwarmResult(c, result)` and `buildSafeFallback(result, serializationErr)`.
  - Replaced duplicated circular-safe JSON serialization and fallback construction in `/api/swarm/analyze`.

- [x] **6. Endpoint Error Handling Boilerplate**
  - Extracted `handleServerError(context, err, c)` helper function.
  - Registered global `app.onError` handler on Hono app and streamlined all route-level catch blocks.

---

## Verification
- `tsc --noEmit` passed with 0 errors.
- Vitest unit tests passed: 93/93 suites, 863/863 tests.
- Swarm rollup package built cleanly (`npm run build:swarm`).
- Production smoke start test passed (`GET /api/health -> 200 {"status":"ok","edge":true}`).
