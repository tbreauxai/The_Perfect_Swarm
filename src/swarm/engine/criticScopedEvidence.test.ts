import { describe, it, expect, vi } from 'vitest';
import { createAnalystExecutor } from './analystExecution.ts';
import { AnalysisLifecycle } from '../lifecycle.ts';
import { SwarmContext } from '../context.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { GameQueryCache } from '../cache/gameQueryCache.ts';
import { CRITIC_VERDICT_SYSTEM_INSTRUCTION } from './constants.ts';

describe('Critic Scoped Evidence Pulls (Goal 2 & Goal 3)', () => {
  const SLATE = [
    'event_id=nba-lal | sport=nba | SAS @ Los Angeles Lakers | options: R1 Lakers -7.5',
    'event_id=nba-lac | sport=nba | SAC @ Los Angeles Clippers | options: R2 Clippers -6.5',
    'event_id=nhl-dal | sport=nhl | MIN @ Dallas Stars | options: R3 Dallas ML',
    'event_id=nba-orl | sport=nba | MIA @ Orlando Magic | options: R4 Magic -2.5',
    'event_id=nfl-kc | sport=nfl | BUF @ Kansas City Chiefs | options: R5 Chiefs -3.0'
  ].join('\n');

  it('CRITIC_VERDICT_SYSTEM_INSTRUCTION includes CRITIC SCOPE rules', () => {
    expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain('CRITIC SCOPE:');
    expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain('Only pull evidence for the games/legs the analyzers proposed.');
    expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain('Do not scan the full slate.');
  });

  it('Stage 2 Risk Critic restricts headers and tool pulls strictly to targetGameIds (excludes unselected games)', async () => {
    const pulledByTool: Array<{ tool: string; gameId: string }> = [];
    const mkTool = (name: string) => ({
      name,
      description: name,
      parameters: {
        game_id: { type: 'string' as const, description: 'id', required: true },
        market_type: { type: 'string' as const, description: 'm' }
      },
      execute: vi.fn(async ({ game_id }: any) => {
        pulledByTool.push({ tool: name, gameId: game_id });
        return { success: true, summary: `[${name}: ${game_id}] verified` };
      })
    });

    const registry = new ToolRegistry([
      mkTool('get_injury_and_roster_delta'),
      mkTool('get_market_movement'),
      mkTool('get_matchup_fundamentals'),
      mkTool('get_environment_and_weather')
    ]);

    let capturedCriticPrompt = '';
    const criticAgent: any = {
      id: 'critic',
      role: 'Risk Critic',
      provider: 'openrouter',
      setSystemInstruction: vi.fn(),
      run: vi.fn(async (p: string) => {
        capturedCriticPrompt = p;
        return JSON.stringify({ pass: true, verdict: 'All 3 legs verified', flags: [] });
      })
    };

    const executeAnalyst = createAnalystExecutor({
      task: 'Build a 3-leg parlay',
      historicalContext: '',
      chunks: [SLATE],
      context: new SwarmContext(),
      profile: {} as any,
      targetAppId: 'duelodds',
      toolRegistry: registry,
      analystClusterMap: new Map(),
      bypassCache: true
    });

    const res: any = await executeAnalyst(criticAgent, SLATE, 0, {
      summaryText: '- [Quant] Proposed 3 leg(s): Lakers -7.5 | Clippers -6.5 | Dallas ML',
      targetGameIds: ['nba-lal', 'nba-lac', 'nhl-dal']
    });

    expect(res.pass).toBe(true);
    // Selected games appear in Critic prompt; unselected games do NOT
    expect(capturedCriticPrompt).toContain('nba-lal');
    expect(capturedCriticPrompt).toContain('nba-lac');
    expect(capturedCriticPrompt).toContain('nhl-dal');
    expect(capturedCriticPrompt).not.toContain('nba-orl');
    expect(capturedCriticPrompt).not.toContain('nfl-kc');

    // Tool pulls only ran for selected games
    const pulledGameIds = new Set(pulledByTool.map(x => x.gameId));
    expect(pulledGameIds).toEqual(new Set(['nba-lal', 'nba-lac', 'nhl-dal']));
    expect(pulledByTool.some(x => x.tool === 'get_market_movement')).toBe(true);
    expect(pulledByTool.some(x => x.tool === 'get_injury_and_roster_delta')).toBe(true);
  });

  it('Verification Critic pulls fresh/cached evidence for proposed legs even when pre-passed bundle is truncated/incomplete', async () => {
    const pulledGames = new Set<string>();
    const mkTool = (name: string, formatter: (id: string) => string) => ({
      name,
      description: name,
      parameters: {
        game_id: { type: 'string' as const, description: 'id', required: true },
        market_type: { type: 'string' as const, description: 'm' }
      },
      execute: vi.fn(async ({ game_id }: any) => {
        pulledGames.add(game_id);
        return { success: true, summary: formatter(game_id) };
      })
    });

    const registry = new ToolRegistry([
      mkTool('get_market_movement', id => `[MARKET MOVEMENT: ${id}] spread/ml_home confirmed`),
      mkTool('get_injury_and_roster_delta', id => `[INJURY & ROSTER DELTA: ${id}] Healthy`),
      mkTool('get_matchup_fundamentals', id => `[MATCHUP FUNDAMENTALS: ${id}] Net +5.2`)
    ]);

    const proposer: any = {
      role: 'Manager',
      modelName: 'm',
      provider: 'openrouter',
      run: vi.fn(async () => JSON.stringify({
        summary: '3-leg parlay: Lakers -7.5, Clippers -6.5, Dallas Stars ML',
        picks: [
          { event_id: 'nba-lal', selection: 'Los Angeles Lakers -7.5' },
          { event_id: 'nba-lac', selection: 'Los Angeles Clippers -6.5' },
          { event_id: 'nhl-dal', selection: 'Dallas Stars ML' }
        ]
      }))
    };

    let verifyPrompt = '';
    const critic: any = {
      role: 'Risk Critic',
      modelName: 'c',
      provider: 'groq',
      run: vi.fn(async (p: string) => {
        verifyPrompt = p;
        return JSON.stringify({ pass: true, feedback: 'All 3 legs verified from scoped tool pulls.' });
      })
    };

    const lifecycle = new AnalysisLifecycle(proposer, critic, 2, {
      toolRegistry: registry,
      queryCache: new GameQueryCache()
    });

    const result = await lifecycle.executeAndVerify(
      {
        rawBoard: SLATE,
        analystReports: '[Quant] Lakers -7.5, Clippers -6.5, Dallas ML',
        // Truncated pre-passed bundle missing NBA games
        toolResults: 'EVENT nhl-other AWAY @ HOME\nMKT: unrelated NHL game'
      },
      new SwarmContext(),
      'Compile parlay',
      'Verify parlay'
    );

    expect(result.success).toBe(true);
    expect(result.computedRating).toBe(0.98);
    expect(result.verifiedEventIds).toEqual(expect.arrayContaining(['nba-lal', 'nba-lac', 'nhl-dal']));
    expect(pulledGames).toEqual(new Set(['nba-lal', 'nba-lac', 'nhl-dal']));
    expect(verifyPrompt).toContain('nba-lal');
    expect(verifyPrompt).toContain('nba-lac');
    expect(verifyPrompt).toContain('nhl-dal');
    expect(verifyPrompt).not.toContain('nba-orl');
    expect(verifyPrompt).not.toContain('nfl-kc');
    expect(verifyPrompt.length).toBeLessThanOrEqual(5600);
  });

  it('2 cited of 12 games: critic prompt and tool calls name only those 2', async () => {
    const twelveGames = Array.from({ length: 12 }, (_, i) => {
      const idx = i + 1;
      return `event_id=nba-g${idx} | sport=nba | Away${idx} @ Home${idx} | options: R${idx} Home${idx} -${idx}.5 (-110)`;
    }).join('\n');

    const pulledByTool: Array<{ tool: string; gameId: string }> = [];
    const mkTool = (name: string) => ({
      name,
      description: name,
      parameters: { game_id: { type: 'string' as const, description: 'id', required: true } },
      execute: vi.fn(async ({ game_id }: any) => {
        pulledByTool.push({ tool: name, gameId: game_id });
        return { success: true, summary: `[${name}: ${game_id}] ok` };
      })
    });

    const registry = new ToolRegistry([
      mkTool('get_injury_and_roster_delta'),
      mkTool('get_market_movement'),
      mkTool('get_matchup_fundamentals'),
      mkTool('get_environment_and_weather')
    ]);

    let capturedPrompt = '';
    const criticAgent: any = {
      id: 'critic',
      role: 'Risk Critic',
      provider: 'groq',
      setSystemInstruction: vi.fn(),
      run: vi.fn(async (p: string) => {
        capturedPrompt = p;
        return JSON.stringify({ pass: true, verdict: 'Verified 2 cited games', flags: [] });
      })
    };

    const executeAnalyst = createAnalystExecutor({
      task: 'Audit 2 cited games',
      historicalContext: '',
      chunks: [twelveGames],
      context: new SwarmContext(),
      settings: { appId: 'duelodds' },
      toolRegistry: registry,
      analystClusterMap: new Map()
    });

    await executeAnalyst(criticAgent, twelveGames, 0, {
      summaryText: 'Proposed: Home3 -3.5, Home10 -10.5',
      targetGameIds: ['nba-g3', 'nba-g10'],
      proposerReports: [],
      proposedPicks: []
    });

    const pulledIds = new Set(pulledByTool.map(p => p.gameId));
    expect(pulledIds).toEqual(new Set(['nba-g3', 'nba-g10']));
    expect(capturedPrompt).toContain('Away3 @ Home3');
    expect(capturedPrompt).toContain('Away10 @ Home10');
    expect(capturedPrompt).not.toContain('nba-g1 ');
    expect(capturedPrompt).not.toContain('nba-g12');
    expect(capturedPrompt.length).toBeLessThanOrEqual(5600);
  });

  it('0 cited games: no Game Slate, no tool pulls, critic confirms pass/no-picks', async () => {
    const pulledByTool: Array<{ tool: string; gameId: string }> = [];
    const mkTool = (name: string) => ({
      name,
      description: name,
      parameters: { game_id: { type: 'string' as const, description: 'id', required: true } },
      execute: vi.fn(async ({ game_id }: any) => {
        pulledByTool.push({ tool: name, gameId: game_id });
        return { success: true, summary: `[${name}: ${game_id}] ok` };
      })
    });

    const registry = new ToolRegistry([
      mkTool('get_injury_and_roster_delta'),
      mkTool('get_market_movement')
    ]);

    let capturedPrompt = '';
    const criticAgent: any = {
      id: 'critic',
      role: 'Risk Critic',
      provider: 'groq',
      setSystemInstruction: vi.fn(),
      run: vi.fn(async (p: string) => {
        capturedPrompt = p;
        return JSON.stringify({ pass: true, verdict: 'No picks proposed', flags: [] });
      })
    };

    const executeAnalyst = createAnalystExecutor({
      task: 'Audit slate',
      historicalContext: '',
      chunks: [SLATE],
      context: new SwarmContext(),
      settings: { appId: 'duelodds' },
      toolRegistry: registry,
      analystClusterMap: new Map()
    });

    await executeAnalyst(criticAgent, SLATE, 0, {
      summaryText: 'No picks proposed',
      targetGameIds: [],
      proposerReports: [],
      proposedPicks: []
    });

    expect(pulledByTool).toHaveLength(0);
    expect(capturedPrompt).not.toContain('Game Slate:');
    expect(capturedPrompt).not.toContain('nba-lal');
    expect(capturedPrompt).toContain('Confirm pass/no-picks');
  });
});
