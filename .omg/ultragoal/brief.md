# Ultragoal Brief: Harden Provider Adapters (JSON-mode fallout + reasoning models + timeouts)

## Objective
Harden all LLM provider adapters in `The_Perfect_Swarm`:
1. Add 400-retry-without-format fallback to `groq.ts`, `nvidia.ts`, `mistral.ts`, `openrouter.ts`, and `gemini.ts` to prevent server-side format rejections (`json_validate_failed`, etc.) from failing the pipeline.
2. In `nvidia.ts`, add a single retry on timeout with 25s default timeout per attempt.
3. In `adapter.ts`, harden `sanitizeModelOutput` to extract the largest valid balanced JSON substring and strip untagged reasoning text.
4. Comprehensive unit tests covering 400 format retries, timeout retries, and reasoning leakage sanitization.
