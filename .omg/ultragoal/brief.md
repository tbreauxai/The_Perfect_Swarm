# Ultragoal Brief: Phase 1 Implementation Plan - Ingest & Support "Seed Manifest"

## Goal
Enable the Swarm server to accept and validate the lightweight `SeedManifest` (~150 tokens) on `/api/analyze` and `/api/stream`, bypassing monolithic board string requirements and populating scoped context for downstream triage and tools.

## Architecture Boundaries & Phases
1. **Task 1.1: Add `SeedManifest` Server Contract & Validation**
   - File: `src/swarm/server/slimPayload.ts`
   - Define `SeedManifest` interface with `manifest_version: 'v2-seed'`, `candidate_id`, `game_id`, `sport`, `market_type`, `pricing`, `flags`, and `available_tools`.
   - Implement `isSeedManifestRequest(body: unknown): body is SeedManifest`.
   - Implement `validateSeedManifestRequest(body: SeedManifest): string | null`.

2. **Task 1.3: Tool Whitelist Enforcement in Tool Registry**
   - File: `src/swarm/tools/registry.ts`
   - Add `scoped(whitelistedNames: string[]): ToolRegistry` method or execution filter.
   - Prevent agents from executing tools outside `manifest.available_tools`.

3. **Task 1.2: Support `SeedManifest` in Route Parsers (`analyze` & `stream`)**
   - Files: `src/swarm/server/routes/analyze.ts`, `src/swarm/server/streaming.ts`
   - Update request handling in `/api/swarm/analyze` and `/api/swarm/stream` to recognize `manifest_version === 'v2-seed'`.
   - Store `pricing`, `market_type`, `candidate_id`, and `flags` onto request context without requiring monolithic `data` text.
   - Set `scope.eventIds = [manifest.game_id]` and `scope.sport = manifest.sport`.
   - Pass scoped tool registry restricting execution to `available_tools`.

4. **Task 1.4: Unit & Contract Tests**
   - Files: `src/swarm/server/slimPayload.test.ts`, `src/swarm/tools/registry.test.ts`
   - Test validation passes on valid `v2-seed` `SeedManifest`.
   - Test HTTP 400 rejection on malformed manifest.
   - Verify `scoped` ToolRegistry prevents calling tools outside the manifest whitelist.
   - Run full verification suite (`tsc --noEmit`, vitest, build).
