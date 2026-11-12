# Swarm Fix Plan: Consume Resolved Context from Duelodds

## Goal
Make sure the Swarm actually uses the full context (injuries, form, judgments, etc.) once Duelodds tools start returning resolved data.

## Current Behavior
- Latest Swarm recommendation (2026-11-12 21:11 UTC, “The Perfect Swarm (SSE)”) used raw Odds API event IDs.
- `tools_called` was empty.
- Supporting context exists in Duelodds under canonical IDs but was not pulled.

## Required Changes

### 1. Prefer / Require Context Tools
- Ensure the Swarm’s tool list and system prompt explicitly include (and prefer) the tools that return game context, snapshots, and judgments.
- When an event ID is supplied, the Swarm should call the context tool(s) before finalizing a recommendation or pass.
- If a tool returns a resolved canonical event ID, use that for any follow-up calls.

### 2. Handle Resolved Data
Once Duelodds tools resolve Odds API IDs and return context:
- Consume the returned sections (odds, form, injuries, venue, existing judgment, etc.).
- Include relevant signals in the reasoning (especially injuries and form).
- Populate `tools_called` with the actual tools invoked.

### 3. Prompt / Workflow Adjustments (if hard-coded)
If the Swarm prompt or workflow is hard-coded and does not mention context tools:
- Add a short instruction: “Always resolve and retrieve game context (injuries, form, prior judgments) before making a final recommendation or pass.”
- Prefer tools that return structured context over raw odds-only paths when both are available.

### 4. Logging
- Log which tools were called and whether a canonical event ID was resolved.
- This makes it easy to confirm the fix is working (non-empty `tools_called` + context usage).

## Acceptance Criteria
- New Swarm runs on the test NBA games show non-empty `tools_called`.
- Recommendations reference or clearly use context signals (injuries, form, etc.) when available.
- The Swarm no longer produces recommendations that only see raw odds when richer context exists.

## Test Events
- Odds API IDs that should resolve:
  - `d5c5ae8d56762b45d1ec4b85337878f3` → `nba-401909977`
  - `a98ff1ab79feb59277d989c656f16144` → `nba-401909976`
- Context for both was marked `ready` at 16:55 UTC on 2026-11-12.

## Notes
- Most of the heavy lifting (alias resolution, re-judging `awaiting_lines`, tool implementation) is on the Duelodds side.
- Swarm changes should be minimal: call the tools it’s given and use the richer data they return.
- Coordinate deployment so Duelodds tools are updated before or at the same time as any Swarm prompt/tool-list changes.
