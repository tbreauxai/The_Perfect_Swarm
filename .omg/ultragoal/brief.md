# Phase 4: Upgrade the Qdrant Post-Mortem Loop (Meta-Learning)

## Objective
Ingest structured `[ROUTING RULE]` lessons from Qdrant directly into the Hop 1 Triage Planner, enforce mandatory data requirements identified in past post-mortems, and emit complete `tools_called` telemetry in all workflow responses.

## Constraints & Architecture Boundaries
- Strict typing and Node 22 erasableSyntaxOnly compliance.
- Qdrant collection payload filter indexing for `rule_type`, `sport`, and `market_type`.
- Ingest rules as high-priority constraints: `"MANDATORY DATA REQUIREMENTS FROM PAST LOSSES: ..."`.
- Include `tools_called: string[]` in top-level JSON responses, SSE completion events, and judgment output.
- Zero conversational filler.
