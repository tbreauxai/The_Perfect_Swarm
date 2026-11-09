# The Perfect Swarm - Active Roadmap & Implementation Plan

---

# Phase 1: Ingest & Support "Seed Manifest" (Pending)

## Goal
Enable the Swarm server to accept and validate the lightweight `SeedManifest` (~150 tokens) on `/api/analyze` and `/api/stream`, bypassing monolithic board string requirements and populating scoped context for downstream triage and tools.

### Task 1.1: Add `SeedManifest` Server Contract & Validation
- [ ] **File**: `src/swarm/server/slimPayload.ts`
  - [ ] Mirror `SeedManifest` interface from DuelOdds:
    - `manifest_version: 'v2-seed'`
    - `candidate_id: string`
    - `game_id: string`
    - `sport: string`
    - `market_type: string`
    - `pricing: { selection: string; book_odds: number; fair_prob: number; line?: number }`
    - `flags: { is_dome: boolean; hours_to_kickoff: number; has_active_injury_tags: boolean }`
    - `available_tools: string[]`
  - [ ] Implement `isSeedManifestRequest(body: unknown): body is SeedManifest`.
  - [ ] Implement `validateSeedManifestRequest(body: SeedManifest): string | null`.

### Task 1.2: Support `SeedManifest` in Route Parsers (`analyze` & `stream`)
- [ ] **File**: `src/swarm/server/routes/analyze.ts`
  - [ ] Update `resolveSlimOrReject` / request dispatcher to identify `manifest_version === 'v2-seed'`.
  - [ ] Store `pricing`, `market_type`, `candidate_id`, and `flags` onto request context without requiring monolithic `data` text.
  - [ ] Set `scope.eventIds = [manifest.game_id]` and `scope.sport = manifest.sport`.
- [ ] **File**: `src/swarm/server/streaming.ts`
  - [ ] Ensure SSE streaming route parses and dispatches `SeedManifest` requests seamlessly.

### Task 1.3: Tool Whitelist Enforcement in Tool Registry
- [ ] **File**: `src/swarm/tools/registry.ts`
  - [ ] Add `scoped(whitelistedNames: string[]): ToolRegistry` method or execution filter.
  - [ ] Prevent agents from executing tools outside `manifest.available_tools`.

### Task 1.4: Unit & Contract Tests
- [ ] **File**: `src/swarm/server/slimPayload.test.ts`
  - [ ] Test validation passes on valid `v2-seed` `SeedManifest`.
  - [ ] Test HTTP 400 rejection on malformed manifest.
  - [ ] Verify `scoped` ToolRegistry prevents calling tools outside the manifest whitelist.

---

# Phase 2: Build Read-Only Database Views & Tool Endpoints (Pending)

## Goal
Implement the Swarm-side deterministic tool wrappers for the 6 read-only database endpoints, ensuring deterministic execution, strict parameter validation, and compact markdown/JSON output formatting.

### Task 2.1: Implement DuelOdds Database RPC Tool Set
- [ ] **File**: `src/swarm/tools/dueloddsRpcTools.ts`
  - [ ] Tool 1: `get_matchup_fundamentals`:
    - Parameters: `game_id: string`, `window?: string` ('L5', 'L10', 'season')
    - Calls Supabase RPC `get_matchup_fundamentals_v1`.
    - Formats token-dense summary: pace, net offensive/defensive margins, splits.
  - [ ] Tool 2: `get_injury_and_roster_delta`:
    - Parameters: `game_id: string`, `position_group?: string`
    - Calls Supabase RPC `get_injury_and_roster_delta_v1`.
    - Formats: active/out statuses and expected minute/usage shifts.
  - [ ] Tool 3: `get_player_prop_splits`:
    - Parameters: `player_id: string`, `stat_category: string`, `last_n?: number`, `line?: number`
    - Calls Supabase RPC `get_player_prop_splits_v1`.
    - Formats: hit rate vs line, median, variance, recent game log snippet.
  - [ ] Tool 4: `get_environment_and_weather`:
    - Parameters: `game_id: string`
    - Calls Supabase RPC `get_environment_and_weather_v1`.
    - Returns `is_dome` or wind/precipitation/temperature.
  - [ ] Tool 5: `get_market_movement`:
    - Parameters: `game_id: string`, `market_type: string`
    - Calls Supabase RPC `get_market_movement_v1`.
    - Formats: line open vs current, steam shifts, cross-book divergence.

### Task 2.2: Implement `get_historical_lessons` Qdrant & Supabase Tool
- [ ] **File**: `src/swarm/tools/dueloddsRpcTools.ts`
  - [ ] Tool 6: `get_historical_lessons`:
    - Parameters: `sport: string`, `market_type: string`, `tags?: string[]`
    - Queries Qdrant collection or Supabase `lessons` filtered by `sport`, `market_type`, and `rule_type = 'routing_rule'`.
    - Returns: concise past blind spots and routing rules for that exact market.

### Task 2.3: Register Tools in Swarm Runtime Registry
- [ ] **File**: `src/swarm/tools/builtin.ts` & `src/swarm/tools/index.ts`
  - [ ] Export and register all 6 tools in `standardBuiltinTools` and `globalToolRegistry`.
  - [ ] Ensure tools conform to `SwarmTool` contract and render compact prompt schemas.

### Task 2.4: Unit & Mock Execution Tests
- [ ] **File**: `src/swarm/tools/dueloddsRpcTools.test.ts`
  - [ ] Test parameter validation and error handling for missing credentials or malformed inputs.
  - [ ] Verify token density: each tool result block formatted to <= 250 tokens.
  - [ ] Test short-circuit behavior when `is_dome: true`.
