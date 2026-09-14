# Implementation Plan: Fix Swarm Timeouts and API Errors

- [x] Task: Phase 1 - Increase Timeout Durations
    - [x] Update `groq.ts`, `mistral.ts`, `openrouter.ts`, `github.ts` to use `120000` ms default instead of `30000` ms.
    - [x] Update `agent.ts` and `hierarchy.ts` default timeout values to `120000` ms.
    - [x] Task: Phase Verification & Checkpoint (Refer to workflow.md)

- [x] Task: Phase 2 - Improve Retry & Backoff Logic in `agent.ts`
    - [x] Increase `maxRetries` from `2` to `4`.
    - [x] Update the delay logic from `1000 * attempt` to an exponential backoff sequence (e.g. `2000 * Math.pow(2, attempt - 1)`).
    - [x] Ensure the exponential backoff applies to rate limits and 503s regardless of whether failover is enabled or not.
    - [x] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase: Review Fixes
- [x] Task: Apply review suggestions 03b11b4
