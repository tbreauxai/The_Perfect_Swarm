# Ultragoal Brief: Parallel Async Model Health Checks, TTL Caching, Two-Tier Verification & Circuit Breaker

## Objective
Implement high-throughput, low-latency health verification and fault isolation for LLM models across all providers (Gemini, Groq, OpenRouter, Mistral, GitHub, Simulated):
1. **Parallel Async Health Checks**: Execute model probes concurrently with a short 2-3 second timeout per model via `AbortController`.
2. **5-10 Minute TTL Caching**: Cache health results (latency, tier outcomes, circuit status) for 5-10 minutes to prevent provider rate limits and supply instant, near real-time model dropdown filtering.
3. **Two-Tier Check**:
   - Tier 1: Lightweight HEAD/metadata request to verify endpoint reachability with zero token spend.
   - Tier 2: Minimal inference ping (prompt "ping" / max_tokens=1) to verify active inference serving. Skip Tier 2 if Tier 1 fails.
4. **Circuit Breaker Pattern**:
   - States: `CLOSED` (healthy), `OPEN` (tripped after consecutive failures, e.g. 3), `HALF_OPEN` (trial probe after cooldown, e.g. 30-60s).
   - Temporarily disable repeatedly failing models to protect user workflows and prevent execution hangs.
5. **UI Dropdown Filtering**:
   - Integrate health and circuit status into `src/services/providerService.ts` and `src/components/AgentConfigurator.tsx` for real-time visual health badges and filtering options.

## Architecture Boundaries
- Zero external runtime dependencies; pure TypeScript.
- Core logic in `src/swarm/health.ts` for reuse across SwarmEngine, ModelRouter, CLI, and Web UI.
- Client integration in `src/services/providerService.ts` and `src/components/AgentConfigurator.tsx`.
- 100% backward compatibility with existing tests and provider configurations.
