# Phase 3: Two-Hop "Triage & Fetch" Swarm Loop

## Objective
Implement a Planner-Executor pattern:
- **Hop 1 (Triage Planner)** selects up to 3 tools based on `SeedManifest` + Qdrant lessons.
- **Parallel Execution Layer** queries Supabase via tools with a 10-minute game-level cache and single-flight coalescing, assembling a token-dense `CuratedDossier` (300-500 tokens).
- **Hop 2 (Specialist Debate)** grounds specialist analysts with `CuratedDossier` as primary evidence block and disables multi-turn ad-hoc tool calling in Hop 2.
- Emits SSE events: `hop1_plan`, `hop1_exec`, `curated_dossier`, `analyst_start`.

## Constraints & Architecture Boundaries
- Preserve existing streaming SSE and REST dispatch behavior.
- Use Node 22 erasableSyntaxOnly TypeScript syntax.
- Ensure strict 1500ms timeout per tool execution in Hop 1.
- Tool selection hard cap: max 3 tool calls, whitelisted against `manifest.available_tools`.
- GameQueryCache TTL = 10 minutes (600,000ms), keyed by `(game_id, tool_name, param_hash)`, with single-flight promise deduplication.
- Zero conversational filler.
