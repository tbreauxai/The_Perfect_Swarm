# Phase 2: Build Read-Only Database Views & Tool Endpoints (Completed)

## Goal

Implement the Swarm-side deterministic tool wrappers for the 6 read-only database endpoints, ensuring deterministic execution, strict parameter validation, and compact markdown/JSON output formatting.

### Task 2.1: Implement DuelOdds Database RPC Tool Set

- [x] **File**: `src/swarm/tools/dueloddsRpcTools.ts`
  - [x] Tool 1: `get_matchup_fundamentals`:
    - Parameters: `game_id: string`, `window?: string` ('L5', 'L10', 'season')
    - Calls Supabase RPC `get_matchup_fundamentals_v1`.
    - Formats token-dense summary: pace, net offensive/defensive margins, splits.
  - [x] Tool 2: `get_injury_and_roster_delta`:
    - Parameters: `game_id: string`, `position_group?: string`
    - Calls Supabase RPC `get_injury_and_roster_delta_v1`.
    - Formats: active/out statuses and expected minute/usage shifts.
  - [x] Tool 3: `get_player_prop_splits`:
    - Parameters: `player_id: string`, `stat_category: string`, `last_n?: number`, `line?: number`
    - Calls Supabase RPC `get_player_prop_splits_v1`.
    - Formats: hit rate vs line, median, variance, recent game log snippet.
  - [x] Tool 4: `get_environment_and_weather`:
    - Parameters: `game_id: string`
    - Calls Supabase RPC `get_environment_and_weather_v1`.
    - Returns `is_dome` or wind/precipitation/temperature.
  - [x] Tool 5: `get_market_movement`:
    - Parameters: `game_id: string`, `market_type: string`
    - Calls Supabase RPC `get_market_movement_v1`.
    - Formats: line open vs current, steam shifts, cross-book divergence.

### Task 2.2: Implement `get_historical_lessons` Qdrant & Supabase Tool

- [x] **File**: `src/swarm/tools/dueloddsRpcTools.ts`
  - [x] Tool 6: `get_historical_lessons`:
    - Parameters: `sport: string`, `market_type: string`, `tags?: string[]`
    - Queries Qdrant collection or Supabase `lessons` filtered by `sport`, `market_type`, and `rule_type = 'routing_rule'`.
    - Returns: concise past blind spots and routing rules for that exact market.

### Task 2.3: Register Tools in Swarm Runtime Registry

- [x] **File**: `src/swarm/tools/builtin.ts` & `src/swarm/tools/index.ts`
  - [x] Export and register all 6 tools in `standardBuiltinTools` and `globalToolRegistry`.
  - [x] Ensure tools conform to `SwarmTool` contract and render compact prompt schemas.

### Task 2.4: Unit & Mock Execution Tests

- [x] **File**: `src/swarm/tools/dueloddsRpcTools.test.ts`
  - [x] Test parameter validation and error handling for missing credentials or malformed inputs.
  - [x] Verify token density: each tool result block formatted to <= 250 tokens.
  - [x] Test short-circuit behavior when `is_dome: true`.
