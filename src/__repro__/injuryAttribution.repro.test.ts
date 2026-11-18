import { describe, it, expect, vi } from 'vitest';
import { getInjuryAndRosterDeltaTool } from '../swarm/tools/dueloddsRpcTools.ts';
import {
  INJURY_ATTRIBUTION_RULE,
  auditInjuryAttribution,
  sanitizeMisattributedPicksAndText
} from '../swarm/tools/injuryAttribution.ts';
import {
  ANALYST_SYSTEM_INSTRUCTION,
  RED_TEAM_ANALYST_SYSTEM_INSTRUCTION,
  CRITIC_VERDICT_SYSTEM_INSTRUCTION,
  MANAGER_SYSTEM_INSTRUCTION
} from '../swarm/engine/constants.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { SwarmContext } from '../swarm/context.ts';
import { executeSwarmWorkflow } from '../swarm/engine/index.ts';
import { Agent } from '../swarm/agent.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';

const env = { SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_ANON_KEY: 'mock-anon-key' };

describe('Injury Attribution (Minnesota Wild vs Nashville Predators)', () => {
  it('(1) binds Filip Gustavsson (team_id 30) to Minnesota Wild (MIN) and drops injuries with unclear teams', async () => {
    const fetchFn: any = vi.fn(async () =>
      new Response(
        JSON.stringify({
          source: 'snapshot',
          game_id: 'nhl-401892736',
          injuries: [
            {
              team_id: '30',
              player_id: '4352687',
              player_name: 'Filip Gustavsson',
              position: 'G',
              status: 'out',
              detail: 'Lower Body'
            },
            {
              team_id: '',
              player_id: '9999991',
              player_name: 'Mystery Goalie',
              position: 'G',
              status: 'out'
            },
            {
              team_id: '999999',
              player_id: '9999992',
              player_name: 'Unmapped Player',
              position: 'C',
              status: 'out'
            }
          ]
        }),
        { status: 200 }
      )
    );

    const res: any = await getInjuryAndRosterDeltaTool.execute(
      { game_id: 'nhl-401892736' },
      {
        fetchFn,
        env,
        game: {
          event_id: 'nhl-401892736',
          sport: 'icehockey_nhl',
          away_team: 'Nashville Predators',
          home_team: 'Minnesota Wild'
        }
      } as any
    );

    expect(res.success).toBe(true);
    expect(res.summary).toContain('Minnesota Wild (MIN): Filip Gustavsson (G): OUT');
    expect(res.summary).not.toContain('- 30:');
    expect(res.summary).not.toContain('Nashville');
    // Unclear-team injuries must be dropped
    expect(res.summary).not.toContain('Mystery Goalie');
    expect(res.summary).not.toContain('Unmapped Player');
    expect(res.data.injuries).toHaveLength(1);
    expect(res.data.injuries[0].player_name).toBe('Filip Gustavsson');
    expect(res.data.injuries[0].team_name).toBe('Minnesota Wild');
    expect(res.data.injuries[0].team_abbr).toBe('MIN');
  });

  it('(2) includes INJURY ATTRIBUTION RULE in all system instructions', () => {
    for (const instr of [
      ANALYST_SYSTEM_INSTRUCTION,
      RED_TEAM_ANALYST_SYSTEM_INSTRUCTION,
      CRITIC_VERDICT_SYSTEM_INSTRUCTION,
      MANAGER_SYSTEM_INSTRUCTION
    ]) {
      expect(instr).toContain('INJURY ATTRIBUTION RULE:');
      expect(instr).toContain('- Every injury citation must match the team_id or team name in the tool result or board.');
      expect(instr).toContain('- Do not assign a player to the opposing team.');
      expect(instr).toContain('- If the team is not explicit in the tool result, do not cite that injury.');
      expect(instr).toContain('- A reason that puts a player on the wrong team is invalid.');
    }
    expect(INJURY_ATTRIBUTION_RULE).toContain('A reason that puts a player on the wrong team is invalid.');
  });

  it('(3) Critic fails verification when Gustavsson is attributed to Nashville and passes when attributed to Minnesota', async () => {
    const rawBoard =
      'event_id=nhl-401892736 | sport=icehockey_nhl | Nashville Predators @ Minnesota Wild | commence=2026-11-18T01:00:00Z | options: R1 Nashville Predators ML (+105), R2 Minnesota Wild ML (-125)';
    const toolResults =
      'EVENT nhl-401892736 Nashville Predators @ Minnesota Wild\nINJ: Minnesota Wild (MIN): Filip Gustavsson (G): OUT';

    // Case A: Misattributed injury ("Nashville starting goalie Gustavsson is OUT") -> MUST FAIL
    const badProposer: any = {
      role: 'Manager',
      modelName: 'm',
      provider: 'openrouter',
      run: vi.fn(async () =>
        JSON.stringify({
          summary: 'Take Minnesota Wild ML because Nashville starting goalie Gustavsson is OUT.',
          picks: [
            {
              row: 'R2',
              event_id: 'nhl-401892736',
              game: 'Nashville Predators @ Minnesota Wild',
              side: 'Minnesota Wild ML',
              reason: 'Nashville starting goalie Gustavsson is OUT'
            }
          ]
        })
      )
    };
    const permissiveCritic: any = {
      role: 'Risk Critic',
      modelName: 'c',
      provider: 'groq',
      run: vi.fn(async () => JSON.stringify({ pass: true, feedback: 'Looks fine.' }))
    };

    const badRes = await new AnalysisLifecycle(badProposer, permissiveCritic, 1).executeAndVerify(
      {
        analystReports: [{ agent: 'a1', summary: 'Minnesota Wild ML' }],
        rawBoard,
        toolResults
      },
      new SwarmContext(),
      'Compile',
      'Verify'
    );
    expect(badRes.success).toBe(false);
    expect(badRes.criticFeedback).toContain('INJURY ATTRIBUTION RULE');
    expect(badRes.criticFeedback).toContain('Filip Gustavsson');
    expect(badRes.criticFeedback).toContain('Minnesota Wild');

    // Case B: Correctly attributed injury ("Minnesota starting goalie Filip Gustavsson is OUT") -> MUST PASS
    const goodProposer: any = {
      role: 'Manager',
      modelName: 'm',
      provider: 'openrouter',
      run: vi.fn(async () =>
        JSON.stringify({
          summary:
            'Bottom-line call: take R1 Nashville Predators ML. Minnesota Wild starting goalie Filip Gustavsson is OUT, creating a clear crease advantage for Nashville.',
          picks: [
            {
              row: 'R1',
              event_id: 'nhl-401892736',
              game: 'Nashville Predators @ Minnesota Wild',
              side: 'Nashville Predators ML',
              reason: 'Minnesota starting goalie Filip Gustavsson is OUT, giving Nashville the goaltending edge.'
            }
          ]
        })
      )
    };

    const goodRes = await new AnalysisLifecycle(goodProposer, permissiveCritic, 1).executeAndVerify(
      {
        analystReports: [{ agent: 'a1', summary: 'R1 Nashville Predators ML' }],
        rawBoard,
        toolResults
      },
      new SwarmContext(),
      'Compile',
      'Verify'
    );
    expect(goodRes.success).toBe(true);
    expect(goodRes.finalProposal.picks).toHaveLength(1);
    expect(goodRes.finalProposal.picks[0].reason).toContain('Minnesota starting goalie Filip Gustavsson is OUT');
  });

  it('(4) End-to-end recommendation on Minnesota Wild vs Nashville Predators ties Gustavsson only to Minnesota and never invents a Nashville goalie injury', async () => {
    const slate =
      'event_id=nhl-401892736 | sport=icehockey_nhl | Nashville Predators @ Minnesota Wild | commence=2026-11-18T01:00:00Z | options: R1 Nashville Predators ML (+105), R2 Minnesota Wild ML (-125), R3 Nashville Predators +1.5 (-230)';

    const fetchFn: any = vi.fn(async () =>
      new Response(
        JSON.stringify({
          source: 'snapshot',
          game_id: 'nhl-401892736',
          injuries: [
            {
              team_id: '30',
              player_id: '4352687',
              player_name: 'Filip Gustavsson',
              position: 'G',
              status: 'out',
              detail: 'Lower Body'
            }
          ]
        }),
        { status: 200 }
      )
    );

    const injuryTool = {
      ...getInjuryAndRosterDeltaTool,
      execute: (a: any, ctx?: any) => getInjuryAndRosterDeltaTool.execute(a, { ...ctx, fetchFn, env })
    };
    const fundamentalsTool = {
      name: 'get_matchup_fundamentals',
      description: 'fundamentals',
      parameters: { game_id: { type: 'string' as const, description: 'id', required: true } },
      execute: vi.fn(async ({ game_id }: any) => ({
        success: true,
        summary: `[MATCHUP FUNDAMENTALS: ${game_id} (NSH @ MIN)] NSH L10 6-4 (+0.5 net margin) vs MIN L10 5-5 (-0.1 net margin)`
      }))
    };
    const marketTool = {
      name: 'get_market_movement',
      description: 'market',
      parameters: { game_id: { type: 'string' as const, description: 'id', required: true } },
      execute: vi.fn(async ({ game_id }: any) => ({
        success: true,
        summary: `[MARKET MOVEMENT: ${game_id}] FanDuel NSH +105 / MIN -125, spread NSH +1.5 (-230)`
      }))
    };

    const registry = new ToolRegistry([injuryTool as any, fundamentalsTool as any, marketTool as any]);

    let a1SawPrompt = '';
    const runSpy = vi.spyOn(Agent.prototype, 'run').mockImplementation(async function (this: Agent, prompt: string) {
      const role = (this.id || this.role || '').toLowerCase();
      if (role.includes('a1') || role.includes('quant')) {
        a1SawPrompt = prompt;
        // Simulate a1 emitting one valid pick (Gustavsson on Minnesota) and one invalid misattributed pick (Gustavsson on Nashville)
        return JSON.stringify({
          analysis:
            'Minnesota Wild starting goalie Filip Gustavsson is OUT for Minnesota (team_id 30), giving Nashville Predators the edge in net.',
          picks: [
            {
              row: 'R1',
              event_id: 'nhl-401892736',
              game: 'Nashville Predators @ Minnesota Wild',
              market: 'h2h',
              side: 'Nashville Predators ML',
              confidence: 74,
              reason: 'Minnesota starting goalie Filip Gustavsson is OUT and NSH holds a +0.5 L10 net margin edge.'
            },
            {
              row: 'R2',
              event_id: 'nhl-401892736',
              game: 'Nashville Predators @ Minnesota Wild',
              market: 'h2h',
              side: 'Minnesota Wild ML',
              confidence: 65,
              reason: 'Nashville starting goalie Gustavsson is OUT.'
            }
          ],
          scorecards: [
            {
              row: 'R1',
              game: 'Nashville Predators @ Minnesota Wild',
              pick: 'Nashville Predators ML',
              verdict: 'lean',
              confidence: 74,
              note: 'Minnesota starting goalie Filip Gustavsson is OUT.'
            }
          ]
        });
      }
      if (role.includes('a2') || role.includes('market')) {
        return JSON.stringify({
          analysis: 'Market holds steady on R1 Nashville Predators ML with Minnesota missing starting goalie Filip Gustavsson (OUT).',
          picks: [
            {
              row: 'R1',
              event_id: 'nhl-401892736',
              game: 'Nashville Predators @ Minnesota Wild',
              market: 'h2h',
              side: 'Nashville Predators ML',
              confidence: 72,
              reason: 'Minnesota Wild starting goalie Filip Gustavsson is OUT.'
            }
          ],
          scorecards: []
        });
      }
      if (role.includes('critic') || role.includes('risk') || prompt.includes('OUTPUT CONTRACT (mandatory)')) {
        return JSON.stringify({
          pass: true,
          feedback: 'Verified: Filip Gustavsson OUT is accurately attributed to Minnesota Wild.',
          verdict: 'Verified: Filip Gustavsson OUT is accurately attributed to Minnesota Wild.',
          flags: []
        });
      }
      // Manager synthesis
      return JSON.stringify({
        ui_title: 'NHL Matchup Recommendation: NSH @ MIN',
        pass: true,
        summary:
          'Bottom-line call: back R1 Nashville Predators ML. Both Quant and Market specialists agree on Nashville because Minnesota Wild starting goalie Filip Gustavsson is OUT and Nashville carries a +0.5 L10 net margin vs Minnesota (-0.1). The call flips if Filip Gustavsson is activated for Minnesota.',
        analysis:
          'Bottom-line call: back R1 Nashville Predators ML. Minnesota Wild starting goalie Filip Gustavsson is OUT, giving Nashville the goaltending and L10 form edge.',
        picks: [
          {
            row: 'R1',
            event_id: 'nhl-401892736',
            game: 'Nashville Predators @ Minnesota Wild',
            market: 'h2h',
            side: 'Nashville Predators ML',
            pick: 'Nashville Predators ML',
            confidence: 74,
            reason: 'Minnesota Wild starting goalie Filip Gustavsson is OUT and Nashville holds a 6-4 L10 record (+0.5 net margin).'
          }
        ],
        scorecards: [
          {
            row: 'R1',
            game: 'Nashville Predators @ Minnesota Wild',
            pick: 'Nashville Predators ML',
            verdict: 'lean',
            confidence: 74,
            note: 'Minnesota starting goalie Filip Gustavsson is OUT.'
          }
        ],
        components: []
      });
    });

    try {
      const result = await executeSwarmWorkflow({
        task: 'Recommend the best bet for Minnesota Wild vs Nashville Predators.\nPICK OUTPUT CONTRACT:\nReturn JSON with analysis, picks, scorecards.',
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
          agents: [
            { id: 'a1', role: 'Quant Proposer', provider: 'openrouter', apiKey: 'sk-or-v1-mock', modelName: 'mock-a1' },
            { id: 'a2', role: 'Market Proposer', provider: 'openrouter', apiKey: 'sk-or-v1-mock', modelName: 'mock-a2' },
            { id: 'critic', role: 'Risk Critic', provider: 'groq', apiKey: 'gsk_mock', modelName: 'mock-critic' },
            { id: 'manager', role: 'Manager Node', provider: 'openrouter', apiKey: 'sk-or-v1-mock', modelName: 'mock-manager' }
          ]
        } as any
      });

      // Tool output injected into proposer prompt must tie Gustavsson to Minnesota Wild (MIN)
      expect(a1SawPrompt).toContain('Minnesota Wild (MIN): Filip Gustavsson (G): OUT');
      expect(a1SawPrompt).not.toContain('- 30:');

      const fa = result.finalAnalysis;
      expect(fa).toBeDefined();
      expect(fa.verified).toBe(true);
      expect(fa.pass).toBe(true);
      expect(fa.picks).toHaveLength(1);
      expect(fa.picks[0].side || fa.picks[0].pick).toContain('Nashville Predators ML');
      expect(fa.picks[0].reason).toContain('Minnesota Wild starting goalie Filip Gustavsson is OUT');
      expect(fa.picks[0].reason).not.toMatch(/Nashville starting goalie.*Gustavsson/i);

      // Audit final analysis directly to confirm zero misattributions
      const finalAudit = auditInjuryAttribution(
        fa,
        'INJ: Minnesota Wild (MIN): Filip Gustavsson (G): OUT',
        slate
      );
      expect(finalAudit.pass).toBe(true);
      expect(finalAudit.violations).toEqual([]);
    } finally {
      runSpy.mockRestore();
    }
  });
});
