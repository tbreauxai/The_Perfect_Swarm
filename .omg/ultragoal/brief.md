# Ultragoal Brief: Phase 2 - Build Read-Only Database Views & Tool Endpoints

## Objective
Implement the Swarm-side deterministic tool wrappers for the 6 read-only database endpoints, ensuring deterministic execution, strict parameter validation, and compact markdown/JSON output formatting.

## Architecture Boundaries & Constraints
- Implement tools in `src/swarm/tools/dueloddsRpcTools.ts`.
- All 6 tools implement `SwarmTool`:
  1. `get_matchup_fundamentals` (calls Supabase RPC `get_matchup_fundamentals_v1`)
  2. `get_injury_and_roster_delta` (calls Supabase RPC `get_injury_and_roster_delta_v1`)
  3. `get_player_prop_splits` (calls Supabase RPC `get_player_prop_splits_v1`)
  4. `get_environment_and_weather` (calls Supabase RPC `get_environment_and_weather_v1`, short-circuits when `is_dome: true`)
  5. `get_market_movement` (calls Supabase RPC `get_market_movement_v1`)
  6. `get_historical_lessons` (queries Qdrant or Supabase `lessons` table for routing_rule)
- Register all 6 tools in `src/swarm/tools/builtin.ts` and export in `src/swarm/tools/index.ts`.
- Format results into compact token-dense blocks (<= 250 tokens).
- Maintain Node 22 erasableSyntaxOnly TypeScript compatibility.
- 100% test coverage for input validation, error handling, token density, and dome short-circuiting in `src/swarm/tools/dueloddsRpcTools.test.ts`.
