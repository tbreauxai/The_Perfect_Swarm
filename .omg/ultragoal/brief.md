# Ultragoal Brief: Critic Pulls Evidence Only for Analyzer-Selected Games

- **Objective:** Replace the Critic's reliance on a pre-passed, budget-truncated evidence bundle with direct, game-scoped tool pulls (`get_market_movement`, `get_injury_and_roster_delta`, `get_matchup_fundamentals`, `get_environment_and_weather`) exclusively for analyzer-selected games across both Stage 2 Risk Critic and Deep Analysis Verification Critic.
- **Base Commit:** `45a765f` (`main`)
- **Constraints:**
  - Dual Critic Stage Coverage: both Stage 2 Risk Critic and Deep Analysis Verification Critic are scoped exclusively to analyzer-selected games (`event_id` / row IDs) and never scan or pull tools for unselected slate games.
  - Full Verification Tool Suite for Selected Games: `get_market_movement`, `get_injury_and_roster_delta`, `get_matchup_fundamentals`, `get_environment_and_weather` sharing query cache when available and fetching from tool registry when missing.
  - Strict Verification Rule: a proposed leg fails only when the Critic's own tool pull lacks the cited market/injury/matchup fact or violates Injury Attribution Rule.
  - Node 22 strip-only TS (no parameter properties, enums, namespaces, import=require, decorators).
  - Preserve existing `seatBudget` caps and pass-field contract.
