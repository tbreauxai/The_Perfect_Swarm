import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SeedManifest } from '../server/slimPayload.ts';
import { GameQueryCache } from '../cache/gameQueryCache.ts';
import { planTriage, buildDeterministicTriagePlan } from './triagePlanner.ts';
import { executeTriage, TOOL_EXECUTION_TIMEOUT_MS } from './triageExecutor.ts';
import { ToolRegistry } from '../tools/registry.ts';
import type { SwarmTool } from '../tools/index.ts';
import { executeSwarmWorkflow } from './index.ts';
import { Agent } from '../agent.ts';
import { ProviderRegistry } from '../providers/registry.ts';

describe('Phase 3: Two-Hop Triage & Fetch Pipeline', () => {
  const sampleManifest: SeedManifest = {
    manifest_version: 'v2-seed',
    candidate_id: 'cand-kc-bal-spread',
    game_id: 'game-kc-bal-2026',
    sport: 'americanfootball_nfl',
    market_type: 'spread',
    pricing: {
      selection: 'KC -3.5',
      book_odds: -110,
      fair_prob: 0.54,
      line: -3.5
    },
    flags: {
      is_dome: false,
      hours_to_kickoff: 4,
      has_active_injury_tags: true
    },
    available_tools: [
      'get_matchup_fundamentals',
      'get_injury_and_roster_delta',
      'get_player_prop_splits',
      'get_environment_and_weather',
      'get_market_movement',
      'get_historical_lessons'
    ]
  };

  describe('Task 3.1: Shared Game-Level Query Cache & Single-Flight Fetch', () => {
    let cache: GameQueryCache;

    beforeEach(() => {
      cache = new GameQueryCache({ ttlMs: 600000 }); // 10 minutes
    });

    it('returns cached result on subsequent gets with identical parameters', () => {
      const data = { pace: 98.4, net_margin: +4.2 };
      cache.set('game-1', 'get_matchup_fundamentals', { window: 'L10' }, data);

      const hit = cache.get('game-1', 'get_matchup_fundamentals', { window: 'L10' });
      expect(hit).toEqual(data);

      const miss = cache.get('game-1', 'get_matchup_fundamentals', { window: 'L5' });
      expect(miss).toBeUndefined();
    });

    it('coalesces concurrent requests for identical (game_id, tool_name, params) in single-flight', async () => {
      let callCount = 0;
      const slowFetch = async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 20));
        return { count: callCount, value: 'shared_result' };
      };

      // Dispatch 5 concurrent requests
      const promises = [
        cache.getOrFetch('game-coalesce', 'get_market_movement', { market_type: 'spread' }, slowFetch),
        cache.getOrFetch('game-coalesce', 'get_market_movement', { market_type: 'spread' }, slowFetch),
        cache.getOrFetch('game-coalesce', 'get_market_movement', { market_type: 'spread' }, slowFetch),
        cache.getOrFetch('game-coalesce', 'get_market_movement', { market_type: 'spread' }, slowFetch),
        cache.getOrFetch('game-coalesce', 'get_market_movement', { market_type: 'spread' }, slowFetch)
      ];

      const results = await Promise.all(promises);
      expect(callCount).toBe(1);
      results.forEach((res) => {
        expect(res).toEqual({ count: 1, value: 'shared_result' });
      });

      const stats = cache.getStats();
      expect(stats.coalescedHits).toBe(4);
      expect(stats.hits).toBe(0);
    });

    it('benchmarks cache hit execution time: cached entries return in < 5ms', async () => {
      cache.set('game-bench', 'tool_quick', { k: 'v' }, { fast: true });

      const start = performance.now();
      const res = await cache.getOrFetch('game-bench', 'tool_quick', { k: 'v' }, async () => {
        throw new Error('should not call');
      });
      const durationMs = performance.now() - start;

      expect(res).toEqual({ fast: true });
      expect(durationMs).toBeLessThan(5);
    });

    it('expires entries after TTL', () => {
      const shortTtlCache = new GameQueryCache({ ttlMs: 10 });
      shortTtlCache.set('game-exp', 'tool', {}, { ok: true }, 5);

      expect(shortTtlCache.has('game-exp', 'tool', {})).toBe(true);
      // Wait for expiration
      const start = Date.now();
      while (Date.now() - start < 15) {
        // spin
      }
      expect(shortTtlCache.has('game-exp', 'tool', {})).toBe(false);
      expect(shortTtlCache.get('game-exp', 'tool', {})).toBeUndefined();
    });
  });

  describe('Task 3.2: Hop 1 Triage Planner Guardrails & Budget', () => {
    it('enforces hard budget of at most 3 tools', async () => {
      const plan = await planTriage(sampleManifest, {
        lessons: ['Favor injury reports and market steam for NFL favorites.']
      });

      expect(plan.tool_calls.length).toBeLessThanOrEqual(3);
      expect(plan.tool_calls.length).toBeGreaterThan(0);
      plan.tool_calls.forEach((c) => {
        expect(sampleManifest.available_tools).toContain(c.tool);
      });
    });

    it('respects dome short-circuit rule in planning', () => {
      const domeManifest: SeedManifest = {
        ...sampleManifest,
        flags: {
          ...sampleManifest.flags,
          is_dome: true
        }
      };

      const plan = buildDeterministicTriagePlan(domeManifest);
      const toolNames = plan.tool_calls.map((c) => c.tool);
      expect(toolNames).not.toContain('get_environment_and_weather');
    });

    it('prioritizes injury tool when has_active_injury_tags is true', () => {
      const plan = buildDeterministicTriagePlan(sampleManifest);
      const toolNames = plan.tool_calls.map((c) => c.tool);
      expect(toolNames).toContain('get_injury_and_roster_delta');
    });

    it('prioritizes player prop splits when market_type is player_prop', () => {
      const propManifest: SeedManifest = {
        ...sampleManifest,
        market_type: 'player_prop',
        pricing: {
          selection: 'Travis Kelce Over 65.5 Rec Yds',
          book_odds: -115,
          fair_prob: 0.55,
          line: 65.5
        }
      };

      const plan = buildDeterministicTriagePlan(propManifest);
      const toolNames = plan.tool_calls.map((c) => c.tool);
      expect(toolNames).toContain('get_player_prop_splits');
    });

    it('filters out any tool not in available_tools whitelist', async () => {
      const restrictedManifest: SeedManifest = {
        ...sampleManifest,
        available_tools: ['get_market_movement']
      };

      const plan = await planTriage(restrictedManifest);
      expect(plan.tool_calls.length).toBe(1);
      expect(plan.tool_calls[0].tool).toBe('get_market_movement');
    });
  });

  describe('Task 3.3: Parallel Execution Layer & Curated Dossier Assembler', () => {
    let mockRegistry: ToolRegistry;
    let cache: GameQueryCache;

    beforeEach(() => {
      mockRegistry = new ToolRegistry();
      cache = new GameQueryCache({ ttlMs: 600000 });

      mockRegistry.register({
        name: 'get_injury_and_roster_delta',
        description: 'injury',
        parameters: {},
        execute: async () => ({
          success: true,
          summary: '[INJURIES: game-kc-bal-2026]\nKey player OUT: WR1 hamstring.'
        })
      });

      mockRegistry.register({
        name: 'get_environment_and_weather',
        description: 'weather',
        parameters: {},
        execute: async () => ({
          success: true,
          summary: '[WEATHER: game-kc-bal-2026]\nClear, 65F, wind 5mph.'
        })
      });

      mockRegistry.register({
        name: 'get_market_movement',
        description: 'market',
        parameters: {},
        execute: async () => ({
          success: true,
          summary: '[MARKET MOVEMENT: game-kc-bal-2026]\nOpen -3.0 -> Current -3.5. Steam on KC.'
        })
      });

      mockRegistry.register({
        name: 'get_matchup_fundamentals',
        description: 'fundamentals',
        parameters: {},
        execute: async () => ({
          success: true,
          summary: '[MATCHUP FUNDAMENTALS: game-kc-bal-2026]\nKC Net Margin: +6.2 | BAL Net Margin: +3.1.'
        })
      });
    });

    it('executes planned tools in parallel and stitches a CuratedDossier', async () => {
      const plan = buildDeterministicTriagePlan(sampleManifest);
      const dossier = await executeTriage(plan, sampleManifest, {
        toolRegistry: mockRegistry,
        cache
      });

      expect(dossier.game_id).toBe(sampleManifest.game_id);
      expect(dossier.candidate_id).toBe(sampleManifest.candidate_id);
      expect(dossier.sections.length).toBe(plan.tool_calls.length);
      dossier.sections.forEach((sec) => {
        expect(sec.success).toBe(true);
        expect(sec.summary.length).toBeGreaterThan(10);
      });

      expect(dossier.markdown).toContain('Curated Matchup Dossier');
      expect(dossier.markdown).toContain('game-kc-bal-2026');
      expect(dossier.tokenEstimate).toBeGreaterThan(20);
      expect(dossier.tokenEstimate).toBeLessThan(500);
    });

    it('enforces 1500ms timeout on hanging tools', async () => {
      const slowRegistry = new ToolRegistry();
      slowRegistry.register({
        name: 'get_slow_tool',
        description: 'hangs',
        parameters: {},
        execute: async () => {
          await new Promise((r) => setTimeout(r, 2000));
          return { success: true, summary: 'finally done' };
        }
      });

      const hangPlan = {
        tool_calls: [{ tool: 'get_slow_tool', parameters: { game_id: 'hang-game' } }],
        reasoning: 'test timeout',
        candidate_id: 'cand-hang',
        game_id: 'hang-game',
        sport: 'nfl',
        market_type: 'spread'
      };

      const manifestWithHang: SeedManifest = {
        ...sampleManifest,
        available_tools: ['get_slow_tool']
      };

      const dossier = await executeTriage(hangPlan, manifestWithHang, {
        toolRegistry: slowRegistry,
        cache,
        timeoutMs: 50 // Fast timeout for test
      });

      expect(dossier.sections.length).toBe(1);
      expect(dossier.sections[0].success).toBe(false);
      expect(dossier.sections[0].summary).toContain('TOOL_TIMEOUT');
    });
  });

  describe('Task 3.4 & 3.5: Full Pipeline Integration & SSE Events', () => {
    it('runs two-hop pipeline with SeedManifest and emits hop1_plan, hop1_exec, curated_dossier, analyst_start', async () => {
      const stageEvents: any[] = [];

      ProviderRegistry.register({
        providerName: 'triage-mock',
        async call(options: any) {
          if (options.role === 'Manager Node') {
            return JSON.stringify({
              recommendation: 'KC -3.5',
              confidence: 0.84,
              rationale: 'Solid fundamentals with heavy steam confirmation.'
            });
          }
          return JSON.stringify({
            insights: ['KC -3.5 has strong value based on curated injury and market steam.'],
            anomalies: [],
            confidence: 0.85,
            summary: 'Recommend KC -3.5 cover.'
          });
        }
      } as any);

      const testRegistry = new ToolRegistry();
      testRegistry.register({
        name: 'get_injury_and_roster_delta',
        description: 'injuries',
        parameters: {},
        execute: async () => ({
          success: true,
          summary: '[INJURIES: KC vs BAL] No major cluster injuries.'
        })
      });
      testRegistry.register({
        name: 'get_environment_and_weather',
        description: 'weather',
        parameters: {},
        execute: async () => ({
          success: true,
          summary: '[WEATHER: KC vs BAL] Clear skies, 60F.'
        })
      });
      testRegistry.register({
        name: 'get_market_movement',
        description: 'market movement',
        parameters: {},
        execute: async () => ({
          success: true,
          summary: '[MARKET: KC vs BAL] Line opened -3.0 moved to -3.5.'
        })
      });
      testRegistry.register({
        name: 'get_matchup_fundamentals',
        description: 'fundamentals',
        parameters: {},
        execute: async () => ({
          success: true,
          summary: '[FUNDAMENTALS: KC vs BAL] KC ranks #2 in net EPA/play.'
        })
      });

      const result = await executeSwarmWorkflow({
        task: 'Evaluate candidate cand-kc-bal-spread',
        seedManifest: sampleManifest,
        tools: testRegistry,
        forceFullSwarm: true,
        bypassCache: true,
        settings: {
          agents: [
            { id: 'analyst-1', role: 'Spread Specialist', provider: 'triage-mock', model: 'mock-model', apiKey: 'mock-key' },
            { id: 'manager', role: 'Manager Node', provider: 'triage-mock', model: 'mock-model', apiKey: 'mock-key' }
          ],
          disableMemoryRetrieval: true
        },
        onStage: (payload) => {
          stageEvents.push(payload);
        }
      });

      expect(result).toBeDefined();

      const stages = stageEvents.map((e) => e.stage);
      expect(stages).toContain('hop1_plan');
      expect(stages).toContain('hop1_exec');
      expect(stages).toContain('curated_dossier');
      expect(stages).toContain('analyst_start');

      // Verify hop1_plan had tool calls
      const planEvent = stageEvents.find((e) => e.stage === 'hop1_plan');
      expect(planEvent.plan.tool_calls.length).toBeGreaterThan(0);
      expect(planEvent.plan.tool_calls.length).toBeLessThanOrEqual(3);

      // Verify curated_dossier had markdown
      const dossierEvent = stageEvents.find((e) => e.stage === 'curated_dossier');
      expect(dossierEvent.dossier.markdown).toContain('Curated Matchup Dossier');
    });
  });
});
