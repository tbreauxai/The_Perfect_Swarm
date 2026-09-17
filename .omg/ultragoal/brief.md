# Ultragoal Brief: Manager Multi-Stage Streaming

## Objective
Stream real-time hierarchical cluster digests over SSE before Manager synthesis completes:
1. **Multi-Stage SSE Protocol**: Introduce `swarm_stage` event type in `src/swarm/server.ts` and `src/swarm/client.ts` (`stage: 'cluster_aggregation' | 'manager_synthesis'`), enabling clients to consume interim findings without waiting for the full synthesis LLM response.
2. **Progressive UI Visualization**: Render interim cluster digests, key findings, and anomalies in `src/App.tsx` / `src/components/AnalysisViewer.tsx` while Manager synthesis is actively executing.
3. **End-to-End Verification**: Validate multi-stage event delivery across `test-sse-server.mjs`, client SDK, Vite builds, and all Vitest suites.

## Architecture Boundaries & Constraints
1. **Zero Model Blacklists**: Never add or check any model ban lists. Any user-configured model is strictly valid.
2. **Strict User Model Preservation**: Never alter, override, or default model strings configured by the user in settings.
3. **Zero-Crash Worker Guarding**: All worker analyst outputs must flow through `guardAnalystResponse`.
4. **SSE Stream Resiliency**: Keepalive comments (`:keepalive`) and header flushing must remain intact without stream aborts or memory leaks.
5. **Non-Breaking Compatibility**: Maintain 100% backward compatibility across all 5 test suites (`test:portable`, `test:simulation`, `test:dist`, `test:cli`, `test:server`) and Vitest test suites.

## Micro-Goal Breakdown
1. `goal-1-server-and-client-multi-stage-sse`: Implement `swarm_stage` event emission in `src/swarm/server.ts`, extend `StreamEventPayload` in `src/swarm/client.ts`, and add `onStageUpdate` hook in `src/swarm/engine.ts`.
2. `goal-2-ui-progressive-digest-rendering`: Add progressive cluster digest state and interim preview banner in `src/App.tsx` while Manager node synthesis is executing.
3. `goal-3-verification-and-bundle-build`: Add SSE multi-stage verification in `test-sse-server.mjs` and vitest, rebuild production bundles, and verify 100% passing tests.
