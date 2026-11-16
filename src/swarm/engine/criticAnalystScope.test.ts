import { describe, it, expect, vi } from 'vitest';
import { runSeatWithTools, getRoleToolNames } from './seatToolLoop.ts';
import { ToolRegistry } from '../tools/registry.ts';
import type { SwarmTool } from '../tools/types.ts';
import { Agent } from '../agent.ts';
import { SwarmContext } from '../context.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import { parseGameHeaders, filterPicksByCoverage, getEventIdForPick } from '../context/gameHeaders.ts';
import { AnalysisLifecycle } from '../lifecycle.ts';
import { executeScorecardSynthesis } from './scorecardManager.ts';
import type { Blackboard } from './blackboard.ts';

function createMockTool(name: string, summary: string = `[${name} summary]`): SwarmTool {
  return {
    name,
    description: `Mock tool ${name}`,
    parameters: {
      game_id: { type: 'string', description: 'Game ID', required: true }
    },
    execute: vi.fn(async (params: any) => ({ success: true, summary: `${summary} for ${params?.game_id || 'unknown'}` }))
  };
}

describe('Step 4 Tests: Critic JSON Seat, Per-Game Tools, and Coverage Pruning', () => {
  describe('(a) Critic and strict JSON seats have no tools array and cannot call "json"', () => {
    it('verifies getRoleToolNames for critic returns expected tools', () => {
      expect(getRoleToolNames('critic')).toEqual([
        'get_injury_and_roster_delta',
        'get_environment_and_weather'
      ]);
    });

    it('Agent.run strips tools and does not expand toolRegistry for critic or JSON seats', async () => {
      const tool = createMockTool('get_injury_and_roster_delta');
      const registry = new ToolRegistry([tool]);
      const agent = new Agent(
        'critic',
        'llama-3.3-70b-versatile',
        'groq',
        'mock-api-key',
        undefined,
        [],
        undefined,
        'critic-agent'
      );

      let capturedConfig: any = null;
      const mockAdapter = {
        call: vi.fn(async ({ config }: any) => {
          capturedConfig = config;
          return '{"ui_title":"Critic Assessment","status":"pass"}';
        })
      };
      vi.spyOn(ProviderRegistry, 'get').mockReturnValue(mockAdapter as any);

      const context = new SwarmContext();
      await agent.run('Review proposal', context, {
        responseMimeType: 'application/json',
        tools: [{ type: 'function', function: { name: 'get_injury_and_roster_delta' } }] as any,
        toolChoice: 'auto',
        bypassCache: true
      });

      expect(capturedConfig.tools).toBeUndefined();
      expect(capturedConfig.toolChoice).toBeUndefined();
    });

    it('runSeatWithTools for critic prefetches tools and runs 1 round with no tools in runConfig', async () => {
      const tool1 = createMockTool('get_injury_and_roster_delta', 'Injury report');
      const tool2 = createMockTool('get_environment_and_weather', 'Weather report');
      const registry = new ToolRegistry([tool1, tool2]);

      let capturedRunConfigs: any[] = [];
      const mockCriticAgent: any = {
        id: 'critic-1',
        role: 'critic',
        provider: 'groq',
        run: vi.fn(async (_prompt: string, _ctx: any, config: any) => {
          capturedRunConfigs.push(config);
          return '{"scorecard":{"claims_valid":true,"recommendation":"pass"}}';
        })
      };

      const res = await runSeatWithTools({
        agent: mockCriticAgent,
        seat: 'critic',
        prompt: 'Criticize this slate',
        gameId: 'DAL@BOS',
        registry
      });

      expect(res.rounds).toBe(1);
      expect(tool1.execute).toHaveBeenCalledWith(expect.objectContaining({ game_id: 'DAL@BOS' }), expect.anything());
      expect(tool2.execute).toHaveBeenCalledWith(expect.objectContaining({ game_id: 'DAL@BOS' }), expect.anything());
      expect(res.toolCallsExecuted).toEqual(['get_injury_and_roster_delta', 'get_environment_and_weather']);
      expect(res.coveredEventIds).toEqual(['DAL@BOS']);

      expect(capturedRunConfigs).toHaveLength(1);
      expect(capturedRunConfigs[0].tools).toBeUndefined();
      expect(capturedRunConfigs[0].toolChoice).toBeUndefined();
      expect(mockCriticAgent.run.mock.calls[0][0]).toContain('Injury report for DAL@BOS');
    });
  });

  describe('(b) 3-game parsedHeaders calls tools per game until cap', () => {
    it('executes prefetch tools across 3 games in header order bounded by maxToolCalls', async () => {
      const fundTool = createMockTool('get_matchup_fundamentals', 'Fundamentals');
      const propTool = createMockTool('get_player_prop_splits', 'Prop splits');
      const registry = new ToolRegistry([fundTool, propTool]);

      let capturedPrompt = '';
      const mockAnalyst: any = {
        id: 'a1-groq',
        role: 'a1',
        provider: 'groq', // Groq cap: maxToolCalls = 6
        run: vi.fn()
          .mockRejectedValueOnce(new Error('Groq 400 Bad Request: tool_use_failed'))
          .mockImplementationOnce(async (prompt: string) => {
            capturedPrompt = prompt;
            return 'Analysis of all 3 games complete.';
          })
      };

      const gameIds = ['DAL@BOS', 'NYK@TOR', 'HOU@WAS'];
      const res = await runSeatWithTools({
        agent: mockAnalyst,
        seat: 'a1',
        prompt: 'Analyze matchup slate',
        gameIds,
        registry
      });

      // a1 has 2 tools. 3 games * 2 tools = 6 calls => exactly hits Groq maxToolCalls (6)
      expect(fundTool.execute).toHaveBeenCalledTimes(3);
      expect(propTool.execute).toHaveBeenCalledTimes(3);
      expect(res.toolCallsExecuted).toHaveLength(6);
      expect(res.coveredEventIds).toEqual(['DAL@BOS', 'NYK@TOR', 'HOU@WAS']);
      expect(capturedPrompt).toContain('Fundamentals for DAL@BOS');
      expect(capturedPrompt).toContain('Fundamentals for NYK@TOR');
      expect(capturedPrompt).toContain('Fundamentals for HOU@WAS');
    });
  });

  describe('(c) Proposer / manager / scorecard drops uncovered picks', () => {
    const rawSlate = [
      'event_id=DAL@BOS | sport=basketball_nba | DAL @ BOS | options: R101 BOS -3.5 (-110), R102 O 220 (-110)',
      'event_id=NYK@TOR | sport=basketball_nba | NYK @ TOR | options: R201 TOR +4.5 (-110)',
      'event_id=HOU@WAS | sport=basketball_nba | HOU @ WAS | options: R301 HOU -6.0 (-110)'
    ].join('\n');

    it('correctly maps picks and scorecard R-ids to event IDs and filters by coverage', () => {
      const headers = parseGameHeaders(rawSlate);
      expect(headers).toHaveLength(3);

      expect(getEventIdForPick({ event_id: 'DAL@BOS' }, headers)).toBe('DAL@BOS');
      expect(getEventIdForPick({ id: 'R101' }, headers)).toBe('DAL@BOS');
      expect(getEventIdForPick({ row: 'R201' }, headers)).toBe('NYK@TOR');
      expect(getEventIdForPick({ match: 'HOU vs WAS' }, headers)).toBe('HOU@WAS');

      const allPicks = [
        { event_id: 'DAL@BOS', selection: 'BOS -3.5' },
        { id: 'R201', selection: 'TOR +4.5' },
        { match: 'HOU@WAS', selection: 'HOU -6.0' }
      ];

      const coveredOnly = filterPicksByCoverage(allPicks, ['DAL@BOS'], headers);
      expect(coveredOnly).toHaveLength(1);
      expect(coveredOnly[0]).toEqual({ event_id: 'DAL@BOS', selection: 'BOS -3.5' });
    });

    it('drops uncovered picks in AnalysisLifecycle and resets to insufficient data if none remain', async () => {
      const mockProposer: any = {
        role: 'proposer',
        run: vi.fn(async () => JSON.stringify({
          ui_title: '3-Game Parlay',
          picks: [
            { event_id: 'DAL@BOS', selection: 'BOS -3.5' },
            { event_id: 'NYK@TOR', selection: 'TOR +4.5' }
          ]
        }))
      };

      const mockCritic: any = {
        role: 'critic',
        run: vi.fn(async () => JSON.stringify({
          approved: true,
          rating: 8.5
        }))
      };

      const lifecycle = new AnalysisLifecycle(mockProposer, mockCritic);
      const context = new SwarmContext();

      const result = await lifecycle.executeAndVerify(
        rawSlate,
        context,
        'Propose picks',
        'Verify picks',
        ['DAL@BOS'] // Only DAL@BOS covered
      );

      expect(result.finalProposal.picks).toHaveLength(1);
      expect(result.finalProposal.picks[0].event_id).toBe('DAL@BOS');

      // Test all uncovered -> no_play / insufficient data
      const mockUncoveredProposer: any = {
        role: 'proposer',
        run: vi.fn(async () => JSON.stringify({
          ui_title: 'Uncovered Parlay',
          picks: [
            { event_id: 'NYK@TOR', selection: 'TOR +4.5' },
            { event_id: 'HOU@WAS', selection: 'HOU -6.0' }
          ]
        }))
      };

      const lifecycle2 = new AnalysisLifecycle(mockUncoveredProposer, mockCritic);
      const result2 = await lifecycle2.executeAndVerify(
        rawSlate,
        context,
        'Propose picks',
        'Verify picks',
        ['DAL@BOS'] // Only DAL@BOS covered
      );

      expect(result2.finalProposal.picks).toHaveLength(0);
      expect(result2.finalProposal.ui_title).toBe('Insufficient data');
      expect(result2.finalProposal.reason).toBe('no picks with specialist coverage');
    });

    it('drops uncovered picks in executeScorecardSynthesis', async () => {
      const blackboard: Blackboard = {
        brief: 'Test slate',
        board: rawSlate,
        scorecards: [],
        citedRows: ['R101', 'R201'],
        unknownRows: [],
        coveredEventIds: ['DAL@BOS']
      };

      const mockManager: any = {
        id: 'manager-1',
        role: 'manager',
        provider: 'groq',
        setSystemInstruction: vi.fn(),
        run: vi.fn(async () => JSON.stringify({
          ui_title: 'Manager Slate Picks',
          picks: [
            { event_id: 'DAL@BOS', selection: 'BOS -3.5' },
            { event_id: 'NYK@TOR', selection: 'TOR +4.5' }
          ]
        }))
      };

      const context = new SwarmContext();
      const synthesis = await executeScorecardSynthesis({
        blackboard,
        managerAgent: mockManager,
        analysts: [],
        dedicatedCriticAgent: null,
        runCritic: false,
        context
      });

      expect(synthesis.picks).toHaveLength(1);
      expect(synthesis.picks[0].event_id).toBe('DAL@BOS');
    });
  });
});
