# The Perfect Swarm - Active Roadmap & Implementation Plan

---

# Phase 1: Ingest & Support "Seed Manifest" (Complete)

## Goal
Enable the Swarm server to accept and validate the lightweight `SeedManifest` (~150 tokens) on `/api/analyze` and `/api/stream`, bypassing monolithic board string requirements and populating scoped context for downstream triage and tools.

### Task 1.1: Add `SeedManifest` Server Contract & Validation
- [x] **File**: `src/swarm/server/slimPayload.ts`
  - [x] Mirror `SeedManifest` interface from DuelOdds:
    - `manifest_version: 'v2-seed'`
    - `candidate_id: string`
    - `game_id: string`
    - `sport: string`
    - `market_type: string`
    - `pricing: { selection: string; book_odds: number; fair_prob: number; line?: number }`
    - `flags: { is_dome: boolean; hours_to_kickoff: number; has_active_injury_tags: boolean }`
    - `available_tools: string[]`
  - [x] Implement `isSeedManifestRequest(body: unknown): body is SeedManifest`.
  - [x] Implement `validateSeedManifestRequest(body: SeedManifest): string | null`.

### Task 1.2: Support `SeedManifest` in Route Parsers (`analyze` & `stream`)
- [x] **File**: `src/swarm/server/routes/analyze.ts`
  - [x] Update `resolveSlimOrReject` / request dispatcher to identify `manifest_version === 'v2-seed'`.
  - [x] Store `pricing`, `market_type`, `candidate_id`, and `flags` onto request context without requiring monolithic `data` text.
  - [x] Set `scope.eventIds = [manifest.game_id]` and `scope.sport = manifest.sport`.
- [x] **File**: `src/swarm/server/streaming.ts`
  - [x] Ensure SSE streaming route parses and dispatches `SeedManifest` requests seamlessly.

### Task 1.3: Tool Whitelist Enforcement in Tool Registry
- [x] **File**: `src/swarm/tools/registry.ts`
  - [x] Add `scoped(whitelistedNames: string[]): ToolRegistry` method or execution filter.
  - [x] Prevent agents from executing tools outside `manifest.available_tools`.

### Task 1.4: Unit & Contract Tests
- [x] **File**: `src/swarm/server/slimPayload.test.ts`
  - [x] Test validation passes on valid `v2-seed` `SeedManifest`.
  - [x] Test HTTP 400 rejection on malformed manifest.
  - [x] Verify `scoped` ToolRegistry prevents calling tools outside the manifest whitelist.

---

# Phase 2: Build Read-Only Database Views & Tool Endpoints (Complete)

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

---

# Phase 3: Implement a Two-Hop "Triage & Fetch" Swarm Loop (Complete)

## Goal
Implement a Planner-Executor pattern: Hop 1 Triage Planner selects up to 3 tools based on Seed Manifest + Qdrant lessons; Parallel Execution Layer queries Supabase with a 10-minute game-level cache and stitches a Curated Dossier; Hop 2 Specialists debate and price the pick.

### Task 3.1: Shared Game-Level Query Cache with Single-Flight Fetch
- [x] **File**: `src/swarm/cache/gameQueryCache.ts`
  - [x] Implement `GameQueryCache` with in-memory LRU / Map keyed by `(game_id, tool_name, param_hash)`.
  - [x] Set default TTL = 10 minutes (600,000ms).
  - [x] Add in-flight promise coalescing (`single-flight`) so concurrent bets on the same game share one DB roundtrip.

### Task 3.2: Hop 1 — Triage Planner Module
- [x] **File**: `src/swarm/engine/triagePlanner.ts`
  - [x] Configure ultra-fast model (default: `gemini-2.5-flash-lite`, Groq Llama 3.3, or Mistral Small).
  - [x] Input: `SeedManifest` + Qdrant routing lessons (via `get_historical_lessons`).
  - [x] Output: Strict JSON schema `{ tool_calls: Array<{ tool: string; parameters: Record<string, any> }> }`.
  - [x] Enforce Guardrails: Hard cap `max_tool_calls = 3` and filter against `manifest.available_tools`.

### Task 3.3: Parallel Execution Layer & Curated Dossier Assembler
- [x] **File**: `src/swarm/engine/triageExecutor.ts`
  - [x] Concurrently execute selected tools via `Promise.all` wrapped in `GameQueryCache`.
  - [x] Enforce 1500ms timeout per tool execution.
  - [x] Assemble token-dense `CuratedDossier` Markdown block (target: 300–500 tokens).

### Task 3.4: Hop 2 — Specialist Debate Pipeline Grounding
- [x] **File**: `src/swarm/engine/analystExecution.ts` & `src/swarm/engine/clusterPipeline.ts`
  - [x] Ground specialist analysts with `CuratedDossier` as primary evidence block.
  - [x] Disable multi-turn ad-hoc tool calling in Hop 2; specialists strictly synthesize and adjust probability.
  - [x] Emit SSE events: `hop1_plan`, `hop1_exec`, `curated_dossier`, `analyst_start`.

### Task 3.5: Two-Hop Pipeline Unit & Latency Tests
- [x] **File**: `src/swarm/engine/triagePipeline.test.ts`
  - [x] Test hard tool budget enforcement (truncates > 3 tool calls).
  - [x] Test GameQueryCache hits across multiple evaluations on identical `game_id`.
  - [x] Benchmark execution time: assert cached DB roundtrips execute in < 5ms.

---

# Phase 4: Upgrade the Qdrant Post-Mortem Loop (Meta-Learning) (Completed)

## Goal
Ingest structured `[ROUTING RULE]` lessons from Qdrant directly into the Hop 1 Triage Planner, enforce mandatory data requirements identified in past post-mortems, and emit complete `tools_called` telemetry in all workflow responses.

### Task 4.1: Vector Index & Collection Schema for Routing Rules
- [x] **File**: `src/swarm/memory/cortex.ts` & `src/swarm/learning-persistence.ts`
  - [x] Configure Qdrant collection payload filter index for `rule_type`, `sport`, and `market_type`.
  - [x] Support storing and querying structured routing rules with vector similarity and payload filters.

### Task 4.2: Triage Planner Routing Rule Ingestion
- [x] **File**: `src/swarm/engine/triagePlanner.ts`
  - [x] Before Hop 1 generates `tool_calls`, query Qdrant / Supabase for `rule_type = 'routing_rule'` matching `sport` and `market_type`.
  - [x] Inject retrieved routing rules as high-priority constraints into Hop 1 prompt: `"MANDATORY DATA REQUIREMENTS FROM PAST LOSSES: ..."`.

### Task 4.3: Tool Execution Logging in Workflow Result
- [x] **File**: `src/swarm/engine/index.ts` & `src/swarm/server/routes/analyze.ts`
  - [x] Ensure final workflow response includes `tools_called: string[]` in top-level JSON and SSE completion events.
  - [x] Attach `tools_called` to judgment output for downstream recording.

### Task 4.4: Meta-Learning Feedback Loop Unit & Integration Tests
- [x] **File**: `src/swarm/engine/routingRuleInjection.test.ts`
  - [x] Test that when a `[ROUTING RULE | NFL | Totals]` exists in Qdrant, Hop 1 Planner is forced to include the mandated tools (`get_environment_and_weather`, `get_injury_and_roster_delta`).
  - [x] Verify `tools_called` telemetry is populated in workflow results.
