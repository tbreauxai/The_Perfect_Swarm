# Track Specification: Fix Swarm Timeouts and API Errors

## Overview
Recent changes to the swarm failover logic exposed underlying API timeouts and rate limit errors (503s) by disabling the fallback cascade by default. Upon investigation, all requests use a hardcoded fallback timeout of 30,000ms. For large contexts (e.g. 11,000+ characters), this timeout is too short for slower or free-tier models (like OpenRouter and Mistral) to complete processing, resulting in artificial timeouts. Furthermore, without fallbacks enabled, transient 503 errors from Gemini crash the agent because the retry logic only waits 1-2 seconds between attempts before giving up.

## Functional Requirements
1. **Increase Global Timeout:** Update all default `timeoutMs` assignments in providers (`groq.ts`, `mistral.ts`, `openrouter.ts`, `github.ts`, `agent.ts`, `hierarchy.ts`) from `30000` to a more appropriate duration for large prompt processing (e.g. `120000` ms).
2. **Robust Retry Logic:** In `agent.ts`, improve the internal retry loop when an API encounters a transient error (`503`, `429`, `TIMEOUT`) and `disableFallback` is true (or there are no remaining failover targets). It should apply exponential backoff (e.g., 2s, 4s, 8s) and increase `maxRetries` (e.g. 3 or 4) to ensure temporary network blips or short-term rate limits don't immediately crash the node.

## Out of Scope
- Re-architecting the `AdaptiveLoadBalancer`.
- Changes to the UI configuration options beyond what exists.

## Acceptance Criteria
- Agents processing large payloads (>10k chars) on slower providers complete successfully without hitting a 30s timeout wall.
- Agents that encounter a single 503 or 429 error transparently retry with an increasing delay and eventually succeed, even if fallbacks are completely disabled.
