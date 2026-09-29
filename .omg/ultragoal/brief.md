# Ultragoal Brief: Perfect Swarm Architecture, State, & Robustness (2026-09-29 Tier 4 & Tier 5)

## Objective
Implement remaining optimizations #20 to #29 from `todo.md` (Tier 4: Architecture, State, & Safety and Tier 5: Memory Leaks & Edge Cases):

1. **Goal 1 (State & Memory Leaks):**
   - #20: Preserve Optimizer State on Tab Switch in `App.tsx` (permanent mount with CSS hidden toggle).
   - #25: Unbounded Metrics Arrays in `src/swarm/profiler.ts` (rolling 1000 window on raw latency arrays).
   - #26: Event Listener Leak in `src/swarm/engine/index.ts` (capture `context.subscribe` unsubscribe and cleanup in `try...finally`).

2. **Goal 2 (Agent Config & Dead Code Cleanup):**
   - #27: Add default Critic Agent to `App.tsx` initial agents list.
   - #29: Remove dead `resolveFreeModel` from `src/swarm/providers/openrouter.ts` and clean references.

3. **Goal 3 (UI Virtualization & Throttling):**
   - #21: Virtualize / window timeline rendering in `SwarmEventTimeline.tsx` to handle 500+ events smoothly.
   - #22: Throttle SSE event state updates in `App.tsx` using `requestAnimationFrame` batching.
   - #28: Add pagination to `src/components/generative/DataTable.tsx` to prevent DOM freeze on large tabular outputs.

4. **Goal 4 (Security & Engine Architecture):**
   - #23: Secure Settings Storage in `SettingsModal.tsx` & `App.tsx` (Ephemeral Keys toggle to store in memory only).
   - #24: Modularize `executeSwarmWorkflow` in `src/swarm/engine/` by extracting pipeline stages.

5. **Goal 5 (Verification & TODO Update):**
   - Mark items #20-#29 as `[COMPLETED]` in `todo.md`.
   - Run `npm run lint` (`tsc --noEmit`), `npm test`, and `npm run build` with zero errors.

## Constraints & System Boundaries
- Zero conversational filler and fail-closed ledger checkpointing.
- Preserve backward compatibility with existing server and client contracts.
- Ensure all automated unit tests, server tests, and build scripts pass without regressions.
