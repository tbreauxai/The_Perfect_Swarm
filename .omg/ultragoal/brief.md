# Objective
Investigate and resolve the issue where the execution trace stalls at only three cards and persistently displays a "high traffic" error for the Gemini model.

## Root Cause Hypotheses & Investigation Context
1. **Hardcoded Overloaded Model (`gemini-3.1-pro`)**:
   - `src/App.tsx` hardcodes `{ provider: 'gemini', model: 'gemini-3.1-pro' }` for both Manager Node and Analyst 1 in default state, which persists in browser `localStorage`.
   - `gemini-3.1-pro` is a heavy reasoning model that sheds unpaid/free-tier traffic with `503` / "The model is experiencing high traffic. Please try again later."
   - The recommended high-quota free-tier model is `gemini-2.5-flash`.
2. **Fragile API Versioning (`v1alpha`)**:
   - `src/swarm/providers/gemini.ts` and `src/swarm/engine.ts` explicitly pass `apiVersion: 'v1alpha'`, routing to Google's experimental capacity pools rather than the stable endpoint.
3. **Failover Gap & Disabled Fallbacks**:
   - `isFailoverEligible` in `src/swarm/agent.ts` checks for `503` and `RATE_LIMIT`, but omits string patterns like `"high traffic"`, `"overloaded"`, `"UNAVAILABLE"`.
   - `disableFallback: true` is enabled by default in `App.tsx` and `SettingsModal.tsx`, preventing automatic failover to available backup providers (e.g. Groq, OpenRouter, Mistral).
4. **Execution Pipeline Truncation**:
   - The trace stalls at 3 cards (`Metadata Extracted`, `Token Budgeting`, `Targeted Cortex Retrieval`, or fast-path dispatch) because Analyst 1 or Manager Node unhandled rejection terminates the SSE stream via `swarm_error`.
