import { describe, it, expect, beforeEach } from 'vitest';
import type { SeedManifest } from '../server/slimPayload.ts';
import { planTriage, buildDeterministicTriagePlan } from './triagePlanner.ts';
import { QdrantLearningStore } from '../learning-persistence.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { executeSwarmWorkflow } from './index.ts';
import { ProviderRegistry } from '../providers/registry.ts';

describe('Phase 4: Qdrant Post-Mortem Loop & Routing Rule Ingestion', () => {
  const nflTotalsManifest: SeedManifest = {
    manifest_version: 'v2-seed',
    candidate_id: 'cand-buf-nyj-total',
    game_id: 'game-buf-nyj-2026',
    sport: 'americanfootball_nfl',
    market_type: 'total',
    pricing: {
      selection: 'Under 41.5',
      book_odds: -105,
      fair_prob: 0.56,
      line: 41.5
    },
    flags: {
      is_dome: false,
      hours_to_kickoff: 6,
      has_active_injury_tags: false // Note: injury flag false, but routing rule mandates it!
    },
    available_tools: [
      'get_matchup_fundamentals',
      'get_injury_and_roster_delta',
      'get_environment_and_weather',
      'get_market_movement',
      'get_historical_lessons'
    ]
  };

  describe('Task 4.1: Vector Index & Collection Schema for Routing Rules', () => {
    it('saves and scrolls structured routing rules with sport and market_type filters', async () => {
      const mockPoints: any[] = [];
      const mockClient = {
        getCollections: async () => ({ collections: [{ name: 'swarm_learning' }] }),
        createCollection: async () => {},
        createPayloadIndex: async () => {},
        upsert: async (_col: string, data: any) => {
          mockPoints.push(...data.points);
          return { status: 'completed' };
        },
        scroll: async (_col: string, options: any) => {
          const filter = options?.filter?.must || [];
          const sportFilter = filter.find((f: any) => f.key === 'sport')?.match?.value;
          const marketFilter = filter.find((f: any) => f.key === 'market_type')?.match?.value;

          const matched = mockPoints.filter((pt) => {
            const p = pt.payload || {};
            if (sportFilter && p.sport !== sportFilter) return false;
            if (marketFilter && p.market_type !== marketFilter) return false;
            return true;
          });

          return { points: matched };
        }
      };

      const store = new QdrantLearningStore({ client: mockClient });
      await store.whenReady();

      await store.saveRoutingRule({
        sport: 'americanfootball_nfl',
        market_type: 'total',
        lesson: 'MANDATORY DATA REQUIREMENTS FROM PAST LOSSES: get_environment_and_weather and get_injury_and_roster_delta must be checked for NFL outdoor totals.',
        mandated_tools: ['get_environment_and_weather', 'get_injury_and_roster_delta'],
        confidence: 0.95
      });
      await store.flush();

      expect(mockPoints.length).toBe(1);
      expect(mockPoints[0].payload.rule_type).toBe('routing_rule');
      expect(mockPoints[0].payload.sport).toBe('americanfootball_nfl');
      expect(mockPoints[0].payload.market_type).toBe('total');
      expect(mockPoints[0].payload.mandated_tools).toContain('get_environment_and_weather');

      // Query rules matching NFL Totals
      const rules = await store.queryRoutingRules({
        sport: 'americanfootball_nfl',
        market_type: 'total'
      });

      expect(rules.length).toBe(1);
      expect(rules[0].lesson).toContain('MANDATORY DATA REQUIREMENTS');
      expect(rules[0].mandated_tools).toEqual(['get_environment_and_weather', 'get_injury_and_roster_delta']);

      // Query mismatch sport
      const emptyRules = await store.queryRoutingRules({
        sport: 'basketball_nba',
        market_type: 'total'
      });
      expect(emptyRules.length).toBe(0);
    });
  });

  describe('Task 4.2: Triage Planner Routing Rule Ingestion & Enforcement', () => {
    it('forces inclusion of mandated tools when a routing rule exists', async () => {
      const routingLesson =
        'MANDATORY DATA REQUIREMENTS FROM PAST LOSSES: get_environment_and_weather and get_injury_and_roster_delta are mandatory for outdoor NFL totals.';

      const plan = await planTriage(nflTotalsManifest, {
        lessons: [routingLesson]
      });

      const toolNames = plan.tool_calls.map((c) => c.tool);
      expect(toolNames).toContain('get_environment_and_weather');
      expect(toolNames).toContain('get_injury_and_roster_delta');
      expect(plan.tool_calls.length).toBeLessThanOrEqual(3);
    });

    it('enforces mandated tools in deterministic fallback plan', () => {
      const routingLesson =
        'MANDATORY DATA REQUIREMENTS FROM PAST LOSSES: get_environment_and_weather and get_injury_and_roster_delta are required.';

      const plan = buildDeterministicTriagePlan(nflTotalsManifest, [routingLesson]);
      const toolNames = plan.tool_calls.map((c) => c.tool);

      expect(toolNames).toContain('get_environment_and_weather');
      expect(toolNames).toContain('get_injury_and_roster_delta');
    });
  });

  describe('Task 4.3: Tool Execution Logging in Workflow Result', () => {
    it('attaches tools_called telemetry to the workflow result and finalAnalysis', async () => {
      ProviderRegistry.register({
        providerName: 'phase4-mock',
        async call(options: any) {
          if (options.role === 'Manager Node') {
            return JSON.stringify({
              recommendation: 'Under 41.5',
              confidence: 0.81,
              rationale: 'High winds and key offensive line injuries support the Under.'
            });
          }
          return JSON.stringify({
            insights: ['High winds predicted.'],
            anomalies: [],
            confidence: 0.82,
            summary: 'Lean Under.'
          });
        }
      } as any);

      const registry = new ToolRegistry();
      registry.register({
        name: 'get_environment_and_weather',
        description: 'weather',
        parameters: {},
        execute: async () => ({
          success: true,
          summary: '[WEATHER: BUF vs NYJ] Sustained 24mph winds with gusts to 35mph.'
        })
      });
      registry.register({
        name: 'get_injury_and_roster_delta',
        description: 'injury',
        parameters: {},
        execute: async () => ({
          success: true,
          summary: '[INJURIES: BUF vs NYJ] Center OUT, LT Questionable.'
        })
      });
      registry.register({
        name: 'get_market_movement',
        description: 'market',
        parameters: {},
        execute: async () => ({
          success: true,
          summary: '[MARKET: BUF vs NYJ] Total opened 43.5 steamed down to 41.5.'
        })
      });

      const result = await executeSwarmWorkflow({
        task: 'Analyze candidate cand-buf-nyj-total',
        seedManifest: nflTotalsManifest,
        preloadedGameContext: {
          status: 'ok',
          asOf: '2026-11-06T18:00:00.000Z',
          results: [],
          byEventId: new Map(),
          allReadyForSlim: false,
          missingRequiredSectionsByEvent: {},
          formattedBlock: ''
        },
        tools: registry,
        forceFullSwarm: true,
        bypassCache: true,
        settings: {
          agents: [
            { id: 'analyst-1', role: 'Totals Specialist', provider: 'phase4-mock', model: 'mock', apiKey: 'k' },
            { id: 'manager', role: 'Manager Node', provider: 'phase4-mock', model: 'mock', apiKey: 'k' }
          ],
          disableMemoryRetrieval: true
        }
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result.tools_called)).toBe(true);
      expect(result.tools_called.length).toBeGreaterThan(0);
      expect(result.tools_called).toContain('get_environment_and_weather');
      expect(result.tools_called).toContain('read_game_context_v1');

      // Verify tools_called attached to finalAnalysis
      expect(result.finalAnalysis).toBeDefined();
      expect(Array.isArray(result.finalAnalysis.tools_called)).toBe(true);
      expect(result.finalAnalysis.tools_called).toEqual(result.tools_called);
    });
  });
});
