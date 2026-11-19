import { describe, it, expect, vi, afterEach } from 'vitest';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { executeSwarmWorkflow } from '../swarm/engine/index.ts';
import {
  CRITIC_CALL_DEADLINE_MS,
  getSeatCallDeadlineMs,
  runSeatWithTools
} from '../swarm/engine/seatToolLoop.ts';
import { executeOpenAiCompatibleChat } from '../swarm/providers/baseOpenAi.ts';
import { GroqAdapter } from '../swarm/providers/groq.ts';
import { ProviderRegistry } from '../swarm/providers/registry.ts';
import {
  ALLOWED_FILTERED_SPORTS_TOOLS_V1,
  getMarketMovementTool
} from '../swarm/tools/dueloddsRpcTools.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { countVerifiedCitations } from '../swarm/engine/predictionEnsemble.ts';

const env = { SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_ANON_KEY: 'mock-anon-key' };

describe('Tool calling regression + Critic 45s deadline & failover citations', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('(1) Provider payloads force tool_choice: auto, block container.exec/shell/python, and advertise canonical _v1 filtered tools', async () => {
    const capturedBodies: any[] = [];
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      capturedBodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"ok":true}',
                // Rogue container.exec alongside legitimate _v1 tool call
                tool_calls: [
                  { function: { name: 'container.exec', arguments: '{"cmd":"ls"}' } },
                  { function: { name: 'get_market_movement_v1', arguments: '{"game_id":"nhl-401892752","market_type":"all"}' } }
                ]
              }
            }
          ]
        }),
        { status: 200 }
      );
    });

    const registry = new ToolRegistry([
      {
        name: 'get_matchup_fundamentals',
        description: 'Matchup fundamentals',
        parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
        execute: vi.fn(async () => ({ success: true, summary: 'fund' }))
      },
      {
        name: 'get_injury_and_roster_delta',
        description: 'Injuries',
        parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
        execute: vi.fn(async () => ({ success: true, summary: 'inj' }))
      },
      {
        name: 'get_environment_and_weather',
        description: 'Weather',
        parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
        execute: vi.fn(async () => ({ success: true, summary: 'wx' }))
      },
      {
        name: 'get_market_movement',
        description: 'Market',
        parameters: {
          game_id: { type: 'string', description: 'Game ID', required: true },
          market_type: { type: 'string', description: 'Market', required: true }
        },
        execute: vi.fn(async () => ({ success: true, summary: 'mkt' }))
      },
      {
        name: 'get_player_prop_splits',
        description: 'Props',
        parameters: {
          player_id: { type: 'string', description: 'Player ID', required: true },
          stat_category: { type: 'string', description: 'Stat', required: true }
        },
        execute: vi.fn(async () => ({ success: true, summary: 'prop' }))
      },
      // Attempt to register blocked container.exec tool — must be ignored
      {
        name: 'container.exec',
        description: 'Shell exec',
        parameters: {},
        execute: vi.fn(async () => ({ success: true }))
      }
    ]);

    const openAiTools = registry.toOpenAiTools();
    expect(openAiTools.map((t: any) => t.function.name)).toEqual([...ALLOWED_FILTERED_SPORTS_TOOLS_V1]);
    expect(openAiTools.some((t: any) => t.function.name.includes('container.exec'))).toBe(false);

    // Explicitly try passing tool_choice: 'none' and container.exec to baseOpenAi — both must be sanitized
    const output = await executeOpenAiCompatibleChat(
      {
        modelName: 'openai/gpt-oss-120b',
        apiKey: 'gsk_test',
        prompt: 'Check odds',
        config: {
          toolChoice: 'none' as any,
          tools: [
            ...openAiTools,
            { type: 'function', function: { name: 'container.exec', parameters: {} } },
            { type: 'code_interpreter' }
          ]
        }
      },
      {
        providerName: 'groq',
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        apiKey: 'gsk_test',
        modelName: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: 'Check odds' }],
        maxTokens: 600,
        isJson: false,
        timeoutMs: 10000,
        extraBody: { tool_choice: 'none' }
      }
    );

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].tool_choice).toBe('auto');
    expect(capturedBodies[0].tools.map((t: any) => t.function.name)).toEqual([...ALLOWED_FILTERED_SPORTS_TOOLS_V1]);
    expect(output).not.toContain('container.exec');
    expect(output).toContain('get_market_movement_v1');

    // Empty tools request never sends tool_choice: 'none'
    await new GroqAdapter().call({
      modelName: 'openai/gpt-oss-120b',
      apiKey: 'gsk_test',
      prompt: 'JSON verdict',
      config: {
        responseMimeType: 'application/json',
        toolChoice: 'none' as any,
        tools: []
      }
    });
    expect(capturedBodies[1].tool_choice).toBeUndefined();
    expect(capturedBodies[1].tools).toBeUndefined();
  });

  it('(2) Critic has 45s deadline and fresh failover timeout budget (Groq reject/timeout -> Cloudflare succeeds with citations)', async () => {
    expect(CRITIC_CALL_DEADLINE_MS).toBe(45000);
    expect(getSeatCallDeadlineMs('groq', 'Risk Critic')).toBe(45000);
    expect(getSeatCallDeadlineMs('groq', 'critic')).toBe(45000);

    const providerCalls: Array<{ provider: string; timeoutMs: number; tools?: any[]; toolChoice?: any }> = [];
    const mockGroq = {
      call: vi.fn(async (opts: any) => {
        providerCalls.push({
          provider: 'groq',
          timeoutMs: opts.timeoutMs,
          tools: opts.config?.tools,
          toolChoice: opts.config?.toolChoice
        });
        throw new Error('Groq API Error (400): Tool choice is none, but model called a tool');
      })
    };
    const mockCloudflare = {
      call: vi.fn(async (opts: any) => {
        providerCalls.push({
          provider: 'cloudflare',
          timeoutMs: opts.timeoutMs,
          tools: opts.config?.tools,
          toolChoice: opts.config?.toolChoice
        });
        if (opts.config?.tools?.length > 0) {
          return '[TOOL_CALL:{"tool":"get_market_movement_v1","parameters":{"game_id":"nhl-401892752","market_type":"all"}}]';
        }
        return JSON.stringify({
          pass: true,
          verdict: 'Verified R4 Seattle Kraken ML against ml_home -166.',
          flags: []
        });
      })
    };

    const getSpy = vi.spyOn(ProviderRegistry, 'get').mockImplementation((name: any) => {
      if (name === 'groq') return mockGroq as any;
      if (name === 'cloudflare') return mockCloudflare as any;
      throw new Error(`Unexpected provider ${name}`);
    });

    const registry = new ToolRegistry([
      {
        name: 'get_market_movement',
        description: 'Market movement',
        parameters: {
          game_id: { type: 'string', description: 'Game ID', required: true },
          market_type: { type: 'string', description: 'Market', required: true }
        },
        execute: vi.fn(async ({ game_id }: any) => ({
          success: true,
          markets_covered: ['spread', 'total', 'ml'],
          summary: `[MARKET MOVEMENT: ${game_id} | all]\nCurrent: home -1.5 | ml_home SEA -166`
        }))
      },
      {
        name: 'get_injury_and_roster_delta',
        description: 'Injuries',
        parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
        execute: vi.fn(async ({ game_id }: any) => ({
          success: true,
          summary: `[INJURY & ROSTER DELTA: ${game_id}] Lineups intact.`
        }))
      }
    ]);

    const criticAgent = new Agent(
      'Risk Critic',
      'openai/gpt-oss-120b',
      'groq',
      'gsk_mock',
      undefined,
      [{ provider: 'cloudflare', modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', apiKey: 'acc:tok' }]
    );

    const res = await runSeatWithTools({
      agent: criticAgent,
      seat: 'critic',
      prompt: 'Audit R4 Seattle Kraken ML (nhl-401892752)',
      gameIds: ['nhl-401892752'],
      registry,
      context: new SwarmContext(),
      runConfig: { bypassCache: true }
    });

    getSpy.mockRestore();

    // Round 1 sent canonical _v1 tools with toolChoice: 'auto' to Groq, then failed over to Cloudflare with SAME fresh 43s timeout!
    expect(providerCalls[0].provider).toBe('groq');
    expect(providerCalls[0].toolChoice).toBe('auto');
    expect(providerCalls[0].tools?.map((t: any) => t.function.name)).toEqual([
      'get_injury_and_roster_delta_v1',
      'get_market_movement_v1'
    ]);
    expect(providerCalls[0].timeoutMs).toBe(43000);

    expect(providerCalls[1].provider).toBe('cloudflare');
    expect(providerCalls[1].toolChoice).toBe('auto');
    expect(providerCalls[1].timeoutMs).toBe(43000);

    // Round 2 on Cloudflare (after Groq 400 failover) omitted tools & tool_choice
    expect(providerCalls[2].provider).toBe('groq');
    expect(providerCalls[2].tools).toBeUndefined();
    expect(providerCalls[3].provider).toBe('cloudflare');
    expect(providerCalls[3].tools).toBeUndefined();

    expect(res.rounds).toBe(2);
    expect(res.coveredEventIds).toEqual(['nhl-401892752']);
    expect(res.toolEvidence).toContain('ml_home SEA -166');
    expect(countVerifiedCitations({ ...JSON.parse(res.report), toolEvidence: res.toolEvidence, toolEvidenceItems: res.toolEvidenceItems })).toBeGreaterThan(0);
  });

  it('(3) Full 3-leg parlay workflow finishes cleanly with Critic failover, zero container.exec/tool_choice errors, non-zero Critic citations, and intact ML/row rules', async () => {
    const slate = [
      'event_id=nhl-401892752 | sport=icehockey_nhl | Utah Mammoth @ Seattle Kraken | commence=2026-11-19T03:00:00Z | options: R3 Seattle Kraken -1.5 (+150), R4 Seattle Kraken ML (-166)',
      'event_id=nhl-401892760 | sport=icehockey_nhl | Anaheim Ducks @ Colorado Avalanche | commence=2026-11-19T02:00:00Z | options: R47 Anaheim Ducks +1.5 (-130), R48 Colorado Avalanche -1.5 (+110)',
      'event_id=nba-401909997 | sport=basketball_nba | Sacramento Kings @ Los Angeles Lakers | commence=2026-11-19T03:30:00Z | options: R61 Los Angeles Lakers -7.5 (-110), R62 Sacramento Kings +7.5 (-110)',
      'event_id=nba-401909999 | sport=basketball_nba | Miami Heat @ Orlando Magic | commence=2026-11-19T00:00:00Z | options: R71 Orlando Magic -3.5 (-110)'
    ].join('\n');

    const rpcFetchFn: any = vi.fn(async (_url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      const gId = body.game_id || body.p_game_id;
      if (gId === 'nhl-401892752') {
        return new Response(
          JSON.stringify({
            game_id: 'nhl-401892752',
            opening: { total: 6.5, spread: -1.5, ml_home: -170 },
            latest: { total: 6.5, spread: -1.5, ml_home: -166 },
            line_snapshots: [{ ml_home: -170, spread: -1.5, total: 6.5 }]
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          game_id: gId,
          opening: { total: 224.5, spread: -7.5, ml_home: -280 },
          latest: { total: 224.5, spread: -7.5, ml_home: -290 }
        }),
        { status: 200 }
      );
    });

    const marketTool = {
      ...getMarketMovementTool,
      execute: (args: any, ctx?: any) => getMarketMovementTool.execute(args, { ...ctx, fetchFn: rpcFetchFn, env })
    };
    const pulledInjuryGames: string[] = [];
    const injuryTool = {
      name: 'get_injury_and_roster_delta',
      description: 'Pulls injury status and minute/usage shifts for a game.',
      parameters: { game_id: { type: 'string' as const, description: 'Game ID', required: true } },
      execute: vi.fn(async ({ game_id }: any) => {
        pulledInjuryGames.push(game_id);
        return {
          success: true,
          summary: `[INJURY & ROSTER DELTA: ${game_id}] Key starters active.`
        };
      })
    };
    const fundamentalsTool = {
      name: 'get_matchup_fundamentals',
      description: 'Pulls pace, net margins, ATS splits for a game.',
      parameters: { game_id: { type: 'string' as const, description: 'Game ID', required: true } },
      execute: vi.fn(async ({ game_id }: any) => ({
        success: true,
        summary: `[MATCHUP FUNDAMENTALS: ${game_id}] Edge confirmed.`
      }))
    };
    const weatherTool = {
      name: 'get_environment_and_weather',
      description: 'Pulls dome status or wind/temp/precip for a game.',
      parameters: { game_id: { type: 'string' as const, description: 'Game ID', required: true } },
      execute: vi.fn(async ({ game_id }: any) => ({
        success: true,
        summary: `[ENVIRONMENT & WEATHER: ${game_id}] Indoor arena.`
      }))
    };

    const registry = new ToolRegistry([marketTool as any, injuryTool as any, fundamentalsTool as any, weatherTool as any]);

    const criticRequests: any[] = [];
    const origGet = ProviderRegistry.get.bind(ProviderRegistry);
    vi.spyOn(ProviderRegistry, 'get').mockImplementation((providerName: any) => {
      if (providerName === 'groq' || providerName === 'cloudflare' || providerName === 'openrouter') {
        return {
          providerName,
          call: vi.fn(async (opts: any) => {
            const role = String(opts.role || '').toLowerCase();
            if (role.includes('critic') || role.includes('risk')) {
              criticRequests.push({
                provider: providerName,
                toolChoice: opts.config?.toolChoice,
                toolNames: (opts.config?.tools || []).map((t: any) => t.function?.name),
                timeoutMs: opts.timeoutMs
              });
              // Never allow tool_choice: 'none' or container.exec in any Critic request
              expect(opts.config?.toolChoice).not.toBe('none');
              expect((opts.config?.tools || []).some((t: any) => String(t.function?.name).includes('container.exec'))).toBe(false);

              if (providerName === 'groq' && opts.config?.tools?.length > 0) {
                throw new Error('Groq transient error (503) on Round 1');
              }
              if (opts.config?.tools?.length > 0) {
                return [
                  '[TOOL_CALL:{"tool":"get_market_movement_v1","parameters":{"game_id":"nhl-401892752","market_type":"all"}}]',
                  '[TOOL_CALL:{"tool":"get_injury_and_roster_delta_v1","parameters":{"game_id":"nba-401909997"}}]'
                ].join('\n');
              }
              return JSON.stringify({
                pass: true,
                feedback: 'Verified R4 Seattle ML (-166), R48 Colorado Avalanche -1.5, and R61 Los Angeles Lakers -7.5.',
                verdict: 'All 3 proposed legs verified with ml_home -166 and exact row side matching.',
                flags: []
              });
            }

            if (role.includes('quant') || role.includes('a1')) {
              return JSON.stringify({
                analysis: '3-leg parlay: R4 Seattle Kraken ML, R48 Colorado Avalanche -1.5, R61 Los Angeles Lakers -7.5.',
                picks: [
                  { row: 'R4', event_id: 'nhl-401892752', side: 'Seattle Kraken ML', market: 'ml', confidence: 71 },
                  { row: 'R48', event_id: 'nhl-401892760', side: 'Colorado Avalanche -1.5', market: 'spread', confidence: 69 },
                  { row: 'R61', event_id: 'nba-401909997', side: 'Los Angeles Lakers -7.5', market: 'spread', confidence: 73 }
                ],
                scorecards: []
              });
            }

            if (role.includes('market') || role.includes('a2')) {
              return JSON.stringify({
                analysis: 'Market supports R4 Seattle ML (ml_home -166), R48 Colorado -1.5, R61 Lakers -7.5.',
                picks: [
                  { row: 'R4', event_id: 'nhl-401892752', side: 'Seattle Kraken ML', market: 'ml', confidence: 72 },
                  { row: 'R48', event_id: 'nhl-401892760', side: 'Colorado Avalanche -1.5', market: 'spread', confidence: 68 },
                  { row: 'R61', event_id: 'nba-401909997', side: 'Los Angeles Lakers -7.5', market: 'spread', confidence: 74 }
                ],
                scorecards: []
              });
            }

            return JSON.stringify({
              ui_title: '3-Leg NBA/NHL Parlay',
              pass: true,
              summary:
                'Bottom-line call: play 3-leg parlay with R4 Seattle Kraken ML (-166), R48 Colorado Avalanche -1.5 (+110), and R61 Los Angeles Lakers -7.5 (-110). Both specialists verified ml_home -166 alongside home spreads. The call flips if a late goalie scratch hits Seattle.',
              picks: [
                { row: 'R4', event_id: 'nhl-401892752', side: 'Seattle Kraken ML', market: 'ml', confidence: 72 },
                { row: 'R48', event_id: 'nhl-401892760', side: 'Colorado Avalanche -1.5', market: 'spread', confidence: 69 },
                { row: 'R61', event_id: 'nba-401909997', side: 'Los Angeles Lakers -7.5', market: 'spread', confidence: 74 }
              ],
              components: []
            });
          })
        } as any;
      }
      return origGet(providerName);
    });

    const result = await executeSwarmWorkflow({
      task: 'Build a 3-leg parlay combining NHL and NBA.',
      data: slate,
      originApp: 'duelodds',
      enableDeepAnalysis: true,
      forceFullSwarm: true,
      bypassCache: true,
      disableMemoryRetrieval: true,
      tools: registry,
      settings: {
        openRouterApiKey: 'sk-or-v1-mock',
        groqApiKey: 'gsk_mock',
        cloudflareApiKey: 'acc:tok',
        agents: [
          { id: 'a1', role: 'Quant Proposer', provider: 'openrouter', apiKey: 'sk-or-v1-mock', modelName: 'mock-a1' },
          { id: 'a2', role: 'Market Proposer', provider: 'openrouter', apiKey: 'sk-or-v1-mock', modelName: 'mock-a2' },
          {
            id: 'critic',
            role: 'Risk Critic',
            provider: 'groq',
            apiKey: 'gsk_mock',
            modelName: 'openai/gpt-oss-120b',
            fallbackProviders: [
              { provider: 'cloudflare', modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', apiKey: 'acc:tok' }
            ]
          },
          { id: 'manager', role: 'Manager Node', provider: 'openrouter', apiKey: 'sk-or-v1-mock', modelName: 'mock-manager' }
        ]
      } as any
    });

    // No container.exec anywhere, no tool_choice: none
    expect(JSON.stringify(result)).not.toContain('container.exec');
    expect(JSON.stringify(result)).not.toContain('Tool choice is none');
    expect(result.degraded || []).not.toContain('critic');

    // Critic Stage 2 sent _v1 tools with toolChoice: 'auto' and 45s budget, failed over to Cloudflare cleanly
    const round1CriticCalls = criticRequests.filter(r => r.toolNames.length > 0);
    expect(round1CriticCalls.length).toBeGreaterThanOrEqual(2);
    expect(round1CriticCalls[0].toolChoice).toBe('auto');
    expect(round1CriticCalls[0].toolNames).toEqual([
      'get_injury_and_roster_delta_v1',
      'get_market_movement_v1',
      'get_matchup_fundamentals_v1',
      'get_environment_and_weather_v1'
    ]);
    expect(round1CriticCalls.every(r => r.timeoutMs >= 43000)).toBe(true);

    // Critic never pulled unselected 4th game nba-401909999 (Stage 1 proposers scan the 4-game slate; Stage 2 & Lifecycle Critic only pull the 3 selected games)
    const criticToolEvents = (result.events || []).filter(
      (e: any) => /critic|risk/i.test(String(e.agentRole || '')) && /Executed Tool:|Scoped Critic Tool Pulls/.test(String(e.action || ''))
    );
    expect(criticToolEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(criticToolEvents)).not.toContain('nba-401909999');
    expect(pulledInjuryGames.slice(4)).not.toContain('nba-401909999');

    // Critic citations > 0 on consensus event
    const consensusEvent = (result.events || []).find((e: any) => e.action === 'Cross-Analyst Consensus Synthesized');
    expect(consensusEvent).toBeDefined();
    expect((consensusEvent as any).output.citationCountsBySeat['Risk Critic']).toBeGreaterThan(0);
    expect(result.consensus?.citationCountsBySeat?.['Risk Critic']).toBeGreaterThan(0);

    // Verified 3-leg output preserves Seattle ML (R4), Colorado -1.5 (R48), Lakers -7.5 (R61)
    expect(result.finalAnalysis.verified).toBe(true);
    expect(result.finalAnalysis.picks).toHaveLength(3);
    expect(result.finalAnalysis.picks.map((p: any) => p.row)).toEqual(['R4', 'R48', 'R61']);
  });
});
