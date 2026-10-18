# Ultragoal Brief: Deterministic Agent Output Formatting (NVIDIA + Cloudflare JSON-mode Gap)

## Objective
Fix unstructured prose outputs from NVIDIA NIM and Cloudflare Workers AI agent seats by enforcing JSON mode (`response_format: { type: 'json_object' }`), ensuring machine-readable scorecards without format errors or repairs.

## Scope & Changes
1. `src/swarm/providers/nvidia.ts`: Set `response_format: isJson ? { type: 'json_object' } : undefined`.
2. `src/swarm/providers/cloudflare.ts`: Set `response_format: isJson ? { type: 'json_object' } : undefined` with fallback on 400 error when unsupported; support flexible account ID resolution.
3. `src/swarm/server/modelsProvider.ts`: Set `free: true` on NVIDIA catalog models.
4. `DuelOdds`: `src/services/swarmModelService.ts`: Add `moonshotai/kimi-k2.6` to `DEAD_MODEL_IDS` and set `free: true` on NVIDIA fallbacks.
5. Unit Tests: Comprehensive tests for `NvidiaAdapter` and `CloudflareAdapter` verifying JSON mode and fallback.
