# Ultragoal Brief: System Audit & Full Efficiency and Intelligence Optimization (2026-09-29)

## Objective
Execute a comprehensive optimization loop across all core files to maximize efficiency, intelligence, accuracy, and lightweight execution, enabling free-tier multi-agent swarms to go toe-to-toe with premium paid models.

## Constraints & System Boundaries
- Zero conversational filler.
- Preserve backward compatibility across ESM/CJS distribution bundles, CLI, and HTTP/SSE server contracts.
- Strictly keep execution lightweight without adding heavy dependencies or introducing latency overhead.
- Ensure 100% test pass rate across unit tests, CLI tests, server streaming tests, and zero TypeScript errors (`tsc --noEmit`).

## Micro-Goal Breakdown
1. **goal-1-runtime-consensus-and-reasoning**:
   - Extract `src/swarm/engine/consensusPipeline.ts` to compute semantic consensus, agreement ratios, and isolate dissent across specialist analysts for the Manager Node.
   - Expand `sanitizeModelOutput` in `src/swarm/providers/adapter.ts` to universally strip all reasoning tags (`<think>`, `<thought>`, `<reasoning>`, `[THOUGHT]`).
   - Fix array mutation bug during schema validation retries in `src/swarm/agent.ts` and set `DEFAULT_PROVIDER_MODELS.openrouter` to free model default.

2. **goal-2-fast-path-tools-and-action-cache**:
   - Wire `ToolRegistry` schema injection, tool call parsing, and deterministic tool execution into `src/swarm/engine/fastPath.ts`.
   - Add sub-5ms `actionPlanCache` lookup to fast-path before remote model invocation.
   - Enforce resilient schema guarding via `guardAnalystResponse` in fast-path.

3. **goal-3-precision-routing-and-token-protection**:
   - Refactor `ModelRouter` in `src/swarm/router.ts` using word-boundary regex matching to eliminate false-positive complexity escalations.
   - Align OpenRouter model recommendations with active free endpoints.
   - Optimize verification retry prompt construction in `src/swarm/lifecycle.ts` to eliminate redundant raw data duplication and protect token ceilings.

4. **goal-4-cache-interceptor-and-dedup-scaling**:
   - Add LRU cache bounds and fast key eviction to `src/swarm/actionPlanCache.ts` and `src/swarm/semanticCacheInterceptor.ts`.
   - Ensure cache operations remain bounded in memory under continuous multi-run scenarios.

5. **goal-5-system-verification-and-benchmarking**:
   - Run complete test suite (`npm test`), CLI test (`npm run test:cli`), and server test (`npm run test:server`).
   - Run TypeScript typecheck (`npm run lint`).
   - Build production and distribution bundles (`npm run build`).
   - Run baseline profiler & benchmark (`node benchmark.js`).
   - Update `todo.md` with Tier 6 audit completions.
