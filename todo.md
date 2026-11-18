Swarm Fix: Critic Pulls Evidence Only for Analyzer-Selected Games
Ensure the Swarm Critic (both the Stage 2 Risk Critic and the Deep Analysis Verification Critic) scopes its evaluation strictly to the games/legs proposed by the analyzers and pulls its own authoritative tool evidence (get_market_movement, get_injury_and_roster_delta, get_matchup_fundamentals, etc.) for those selected games rather than relying on a truncated or incomplete pre-passed evidence bundle.
User Review & Critical Decisions
Since the clarification prompt was skipped, this plan uses the recommended defaults below so both Critic stages behave consistently across multi-sport slates (such as NBA + NHL parlays).
Confirmed Default 1 — Dual Critic Stage Coverage: Both the Stage 2 Risk Critic seat and the Deep Analysis Verification Critic loop are scoped exclusively to the analyzer-selected games (event_id / row IDs) and never scan or pull tools for unselected slate games.
Confirmed Default 2 — Full Verification Tool Suite for Selected Games: The Critic is granted access to get_market_movement, get_injury_and_roster_delta, get_matchup_fundamentals, and get_environment_and_weather for the analyzer-selected games, pulling fresh/cached tool evidence per proposed leg before rendering its verdict.
Confirmed Default 3 — Strict Verification Rule: A proposed leg fails verification only when the Critic's own tool pull for that specific game lacks the cited market, injury, or matchup fact (or violates the Injury Attribution Rule), never because an earlier evidence bundle was truncated or omitted a sport/game.

1. Overview & Core Concept
   What It Does: Replaces the Critic's reliance on a pre-passed, budget-truncated evidence string with direct, game-scoped tool pulls for the exact games selected by the analyzers.
   Target Audience / Persona: DuelOdds Swarm analysis consumers requesting multi-sport or multi-leg parlay recommendations (e.g., NBA spreads like Lakers -7.5 and Clippers -6.5 combined with NHL moneyline legs like Dallas ML).
   Key Value: Eliminates false-negative Critic vetoes caused by prompt budget truncation (where later games on a slate were dropped from the pre-passed evidence bundle, causing the Critic to claim "evidence only contains NHL events" and driving RLAIF down to 35%).
2. User Experience & Visual Design
   Key User Flows:
   Analyzer Proposal Phase: Specialist seats (Quant / Market) evaluate the slate and propose specific legs (e.g., Lakers -7.5, Clippers -6.5, Dallas ML).
   Scoped Critic Evidence Pull: The Critic extracts the exact game IDs / row IDs referenced by the proposed legs, filters out unselected slate games, and pulls get_market_movement, get_injury_and_roster_delta, and get_matchup_fundamentals specifically for those selected games.
   Targeted Verification & Verdict: The Critic verifies each leg against the evidence pulled for that game. Valid legs supported by tool data pass on Attempt 1 (98% RLAIF rating) without false "missing coverage" rejections.
   Visual Identity & Theme:
   Aesthetic Direction: Utilitarian, high-signal Swarm telemetry and diagnostic clarity.
   Color Palette & Mood: Preserves the existing dark-mode console theme (--background, --primary, --accent) with clean verification status indicators.
   Typography & Hierarchy: Monospace telemetry traces paired with structured JSON recommendation outputs.
   Component Styling & Layout: Existing Swarm dashboard and API response contracts remain unchanged while verification reliability improves.
   Interactive Feedback & Motion: Swarm trace events log the Critic's scoped game list and tool pulls so operators can inspect the exact per-game evidence verified during each run.
3. Key Product Decisions & Trade-Offs
   Decision 1 — Scoped Per-Game Tool Pulls in Critic Verification
   Chosen Approach: Extract the unique event_ids from the analyzer-selected picks/legs and have the Critic pull get_market_movement, get_injury_and_roster_delta, and get_matchup_fundamentals (sharing the run's query cache when available and fetching live from the tool registry when missing) exclusively for those selected games.
   Why: Guarantees that every proposed leg has complete market (spreads, totals, ml_home/ml_away), injury, and matchup evidence in the Critic's context, even on large multi-sport slates where a full-slate bundle would be truncated.
   Alternatives Considered: Increasing the global prompt budget for pre-passed bundles was rejected because large slates still hit provider token ceilings and waste tokens on games the analyzers didn't pick.
   Decision 2 — Restricting Critic Slate Context to Selected Games
   Chosen Approach: Pass only the analyzer-selected game headers and selected-game tool results to the Critic, removing unselected remainder games from the Critic's prefetch queue and verification prompt.
   Why: Prevents the Critic from wasting tool call capacity on unpicked games or hallucinating missing coverage from unrelated slate rows.
4. Technical Architecture & Data Strategy (Technical Reference)
   Architecture & Component Diagram:
   Code
   ┌─────────────────────────────────────────────────────────────────────────┐
   │ Analyzer Seats (Quant / Market) │
   │ Propose candidate legs (e.g. Lakers -7.5, Clippers -6.5, Dallas ML) │
   └───────────────────────────────────┬─────────────────────────────────────┘
   │
   ▼
   ┌─────────────────────────────────────────────────────────────────────────┐
   │ Selected Game Resolver (Event ID / Row Mapper) │
   │ Maps proposed legs & cited rows -> Selected Game IDs ONLY │
   │ (Drops unselected slate games from Critic scope) │
   └─────────────────┬───────────────────────────────────┬───────────────────┘
   │ │
   ▼ ▼
   ┌───────────────────────────────────┐ ┌───────────────────────────────────┐
   │ Stage 2 Risk Critic Seat │ │ Deep Analysis Verification Loop │
   │ • Receives selected games only │ │ • Extracts proposal leg game IDs │
   │ • Pulls market, injury, matchup │ │ • Pulls market, injury, matchup │
   │ tools for selected games only │ │ tools for proposed legs only │
   │ • Enforces CRITIC SCOPE & │ │ • Verifies legs against Critic's │
   │ INJURY ATTRIBUTION RULE │ │ own per-game tool evidence │
   └─────────────────┬─────────────────┘ └─────────────────┬─────────────────┘
   │ │
   └──────────────────┬──────────────────┘
   ▼
   ┌─────────────────────────────────────────────────────────────────────────┐
   │ Verified Swarm Recommendation Output │
   │ • Grounded spreads (Lakers -7.5, Clippers -6.5) & ML (Dallas ml_home) │
   │ • Preserves pass-field contract & injury attribution enforcement │
   └─────────────────────────────────────────────────────────────────────────┘
   Data Model & State:
   Selected Game Scope: Derived deterministically from picks (event_id, game_id, row, match, side, selection) and scorecard citations mapped against parsed slate headers.
   Critic Tool Set: Includes get_market_movement, get_injury_and_roster_delta, get_matchup_fundamentals, and get_environment_and_weather scoped strictly to the selected game IDs.
   Prompt Rule (CRITIC SCOPE):
   Code
   CRITIC SCOPE:

- You may call tools to verify evidence.
- Only pull evidence for the games/legs the analyzers proposed.
- Do not scan the full slate.
- A leg fails only if your own tool pull for that game does not support the cited market or injury.
- Do not reject a leg solely because a prior evidence bundle was incomplete.
  Interactive Component & State Mapping:
  Stage 2 Risk Critic Execution: When proposedAuditContext.targetGameIds is populated from Stage 1 analyzer proposals, the Critic's allGameIds list is restricted strictly to targetGameIds (never appending unselected remainder games), its board headers are filtered to those games, and its tool pulls fetch market, injury, and matchup data for those games only.
  Verification Critic Loop: Before evaluating a manager/proposer proposal, the lifecycle extracts the event IDs of all proposed legs, executes/resolves tool pulls (get_market_movement, get_injury_and_roster_delta, get_matchup_fundamentals) for those specific games via the tool registry, and builds the Critic's [Tool Evidence] and [Raw Board Sample] exclusively from the selected games.
  Coverage & Grounding Preservation: Any game verified by the Critic's own tool pull is included in coveredEventIds so valid legs (such as Lakers -7.5, Clippers -6.5, and Dallas moneyline supported by ml_home) are never pruned as "uncovered" or rejected due to truncated pre-passed bundles, while legs whose tool pulls lack the cited market/injury or violate team injury attribution still fail verification (pass: false).
