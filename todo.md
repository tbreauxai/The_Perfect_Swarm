# Brief: Harden all provider adapters (JSON-mode fallout + reasoning models + timeouts)

**Repo:** The Perfect Swarm (backend)
**Date:** 2026-10-18
**Status:** Ready to implement.
**Context:** PR #98 added JSON-mode enforcement to the NVIDIA/Cloudflare adapters and it
verified working (Cloudflare 70B: prose → clean JSON; NVIDIA gpt-oss-20b: clean JSON).
But the 8-model rerun exposed three follow-on problems below.

## Problem 1: Groq regression — 400 `json_validate_failed` (HIGHEST PRIORITY)

Both Groq seats now fail where gpt-oss-120b previously gave the cleanest output. Groq's
server-side JSON validator rejects the generation (empty `failed_generation`). Root cause
class: the model emits something non-JSON (tool-call attempt, reasoning trace, or empty
output) and strict `response_format` turns it into a hard 400 instead of letting the
existing zod + repair layer fix it.

**Fix:** add the 400-retry-without-format fallback to `src/swarm/providers/groq.ts`,
copying the pattern PR #98 added to `cloudflare.ts`:

```ts
let activeJson = isJson;
try {
    response = await makeRequest(activeJson);
    if (!response.ok && response.status === 400 && activeJson) {
        const peekError = await response.clone().text().catch(() => '');
        const isFormatRejection = !peekError ||
            peekError.toLowerCase().includes('response_format') ||
            peekError.toLowerCase().includes('format') ||
            peekError.toLowerCase().includes('schema') ||
            peekError.toLowerCase().includes('json');
        if (isFormatRejection) {
            console.warn(`[Groq] Model '${options.modelName}' rejected response_format; retrying without format flag.`);
            activeJson = false;
            response = await makeRequest(false);
        }
    }
}
```

The unvalidated output then flows into the existing `parseJsonSafe` → zod → repair
path in `agent.ts`, which is designed for exactly this.

## Problem 2: Same fallback missing on the other adapters

Only `cloudflare.ts` has the 400-retry. Apply the identical pattern to:

- `src/swarm/providers/nvidia.ts`
- `src/swarm/providers/mistral.ts`
- `src/swarm/providers/gemini.ts`
- `src/swarm/providers/openrouter.ts`

Uniform behavior: every seat degrades gracefully instead of hard-failing on format
rejection. No changes to `agent.ts` or the validation layer.

## Problem 3: Reasoning models leak reasoning text into JSON

`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` emitted raw reasoning
(`}{ ":" } Wait formatting: Must be valid JSON...`) outside any `<think>` tags, so
`sanitizeModelOutput` didn't strip it and validation failed. Two-part fix:

1. In `src/swarm/providers/adapter.ts` `sanitizeModelOutput`: broaden reasoning-leakage
   stripping beyond tagged blocks — also strip leading/trailing non-JSON prose around
   the first `{`…last `}` when `isJson` is true (extract the largest balanced JSON
   substring).
2. Optional (if the above isn't enough): add a per-model opt-out — a small set of
   known reasoning model IDs for which `isJson` is forced false at the adapter level,
   letting the repair layer extract JSON from freeform output.

## Problem 4: NVIDIA timeouts (25s)

`z-ai/glm-5.3` timed out twice at the 25s adapter timeout. Free-tier flakiness can't
be fixed, but one retry on timeout doubles the effective chance. Add a single retry
on `TimeoutError`/`AbortError` in `nvidia.ts` before throwing `[TIMEOUT]`. Keep the
25s per-attempt (fail fast), just attempt twice.

## Explicitly out of scope (provider-side, not fixable in code)

- Mistral 429 rate limits, NVIDIA 503 ResourceExhausted, Groq token-budget limiter
  skips — these are capacity, and the existing failover chain is the correct
  mitigation. Do not build retry-storms around them.

## Verification

1. Unit: each adapter test asserts the 400-retry (mock a 400 with `response_format`
   in the error body, assert second request omits it). Follow the existing
   `cloudflare.test.ts` / `nvidia.test.ts` patterns from PR #98.
2. Live: re-run the 8-model benchmark — Groq 120b must return parseable output
   again (via fallback or clean JSON); no seat should hard-fail on format.
3. Regression: the four previously-working providers behave identically when models
   accept JSON mode (retry path not triggered).
