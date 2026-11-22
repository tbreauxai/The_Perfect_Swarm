import { describe, expect, it, vi } from 'vitest';
import {
  classifyInjuryHealthBalance,
  getInjuryAndRosterDeltaTool,
  getMarketMovementTool,
} from '../swarm/tools/dueloddsRpcTools.ts';
import { compactInjurySummary, compactMarketSummary } from '../swarm/engine/verifierEvidence.ts';
import { computeOutCountDiff, formatUnifiedPerGameDossier } from '../swarm/engine/unifiedDossier.ts';
import {
  auditClaimGrounding,
  auditCriticPremiseContradictions,
} from '../swarm/tools/claimGrounding.ts';
import {
  CRITIC_VERDICT_SYSTEM_INSTRUCTION,
  COMPACT_CRITIC_VERDICT_SYSTEM_INSTRUCTION,
  ANALYST_SYSTEM_INSTRUCTION,
} from '../swarm/engine/constants.ts';
import { createAnalystExecutor } from '../swarm/engine/analystExecution.ts';
import { runClusterPipeline } from '../swarm/engine/clusterPipeline.ts';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';

const mockEnv = {
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_ANON_KEY: 'mock-anon-key',
};

const SLATE_WF = [
  'event_id=nba-401910029 | sport=basketball_nba | Detroit Pistons @ Atlanta Hawks | commence=2026-11-22T23:00:00Z | options: R1 away Detroit Pistons ML (-118), R2 home Atlanta Hawks ML (+100)',
  'event_id=nba-401910032 | sport=basketball_nba | Denver Nuggets @ Chicago Bulls | commence=2026-11-23T01:00:00Z | options: R3 away Denver Nuggets -10.5 (-110), R4 home Chicago Bulls +10.5 (-110)',
].join('\n');

describe('wf-1795367633040 P0-2: Two-sided steam, injury Health Balance, and Critic contra-steam/symmetric-injury vetoes', () => {
  it('(1) get_market_movement formats unambiguous two-sided TOWARD / AGAINST steam for ML, spread, and totals', async () => {
    const mlFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          game_id: 'nba-401910029',
          home_team: 'Atlanta Hawks',
          away_team: 'Detroit Pistons',
          opening: { ml_home: 114, ml_away: -134 },
          latest: { ml_home: 100, ml_away: -118 },
          ml_home: 100,
          ml_away: -118,
          snapshots_tracked: 3,
        }),
        { status: 200 },
      ),
    );
    const mlRes = await (getMarketMovementTool as any).execute(
      { game_id: 'nba-401910029', market_type: 'ml' },
      { fetchFn: mlFetch as any, env: mockEnv },
    );
    expect(mlRes.success).toBe(true);
    expect(mlRes.summary).toContain(
      'Steam: TOWARD home Atlanta Hawks ML (+114 -> +100, +3.3pp implied) | AGAINST away Detroit Pistons ML (-134 -> -118)',
    );

    const spreadFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          game_id: 'nba-401910032',
          home_team: 'Chicago Bulls',
          away_team: 'Denver Nuggets',
          opening: { spread_home: 8.5 },
          latest: { spread_home: 10.5 },
          spread_home: 10.5,
          spread_away: -10.5,
          snapshots_tracked: 3,
        }),
        { status: 200 },
      ),
    );
    const spreadRes = await (getMarketMovementTool as any).execute(
      { game_id: 'nba-401910032', market_type: 'spread' },
      { fetchFn: spreadFetch as any, env: mockEnv },
    );
    expect(spreadRes.success).toBe(true);
    expect(spreadRes.summary).toContain(
      'Steam: TOWARD away Denver Nuggets (-8.5 -> -10.5, 2.0 pts) | AGAINST home Chicago Bulls (+8.5 -> +10.5)',
    );

    const totalFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          game_id: 'nba-401910032',
          home_team: 'Chicago Bulls',
          away_team: 'Denver Nuggets',
          opening: { total: 226.5 },
          latest: { total: 224.5 },
          snapshots_tracked: 3,
        }),
        { status: 200 },
      ),
    );
    const totalRes = await (getMarketMovementTool as any).execute(
      { game_id: 'nba-401910032', market_type: 'total' },
      { fetchFn: totalFetch as any, env: mockEnv },
    );
    expect(totalRes.success).toBe(true);
    expect(totalRes.summary).toContain('Steam: TOWARD Under (226.5 -> 224.5');
  });

  it('(2) get_injury_and_roster_delta & verifierEvidence emit and preserve Summary Health Balance classifications', async () => {
    expect(
      classifyInjuryHealthBalance({
        homeTeam: 'Atlanta Hawks',
        awayTeam: 'Detroit Pistons',
        homeOut: 5,
        homeQ: 0,
        awayOut: 5,
        awayQ: 0,
      }).line,
    ).toBe('Summary: Atlanta Hawks (5 OUT, 0 Q) vs Detroit Pistons (5 OUT, 0 Q) | Health Balance: symmetric');

    expect(
      classifyInjuryHealthBalance({
        homeTeam: 'Chicago Bulls',
        awayTeam: 'Denver Nuggets',
        homeOut: 2,
        homeQ: 3,
        awayOut: 1,
        awayQ: 0,
      }).line,
    ).toBe('Summary: Chicago Bulls (2 OUT, 3 Q) vs Denver Nuggets (1 OUT, 0 Q) | Health Balance: away_advantage (Denver Nuggets)');

    expect(
      classifyInjuryHealthBalance({
        homeTeam: 'Chicago Bulls',
        awayTeam: 'Denver Nuggets',
        homeOut: 1,
        homeQ: 2,
        awayOut: 1,
        awayQ: 2,
      }).line,
    ).toBe('Summary: Chicago Bulls (1 OUT, 2 Q) vs Denver Nuggets (1 OUT, 2 Q) | Health Balance: uncertain_questionable');

    const hawksVsPistonsFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          game_id: 'nba-401910029',
          home_team: 'Atlanta Hawks',
          away_team: 'Detroit Pistons',
          injuries: [
            { team_name: 'Atlanta Hawks', team_abbr: 'ATL', player_name: 'Trae Young', status: 'OUT' },
            { team_name: 'Atlanta Hawks', team_abbr: 'ATL', player_name: 'Jalen Johnson', status: 'OUT' },
            { team_name: 'Atlanta Hawks', team_abbr: 'ATL', player_name: 'Bogdan Bogdanovic', status: 'OUT' },
            { team_name: 'Atlanta Hawks', team_abbr: 'ATL', player_name: 'DeAndre Hunter', status: 'OUT' },
            { team_name: 'Atlanta Hawks', team_abbr: 'ATL', player_name: 'Clint Capela', status: 'OUT' },
            { team_name: 'Detroit Pistons', team_abbr: 'DET', player_name: 'Cade Cunningham', status: 'OUT' },
            { team_name: 'Detroit Pistons', team_abbr: 'DET', player_name: 'Jaden Ivey', status: 'OUT' },
            { team_name: 'Detroit Pistons', team_abbr: 'DET', player_name: 'Tobias Harris', status: 'OUT' },
            { team_name: 'Detroit Pistons', team_abbr: 'DET', player_name: 'Ausar Thompson', status: 'OUT' },
            { team_name: 'Detroit Pistons', team_abbr: 'DET', player_name: 'Jalen Duren', status: 'OUT' },
          ],
        }),
        { status: 200 },
      ),
    );
    const injRes = await (getInjuryAndRosterDeltaTool as any).execute(
      { game_id: 'nba-401910029' },
      { fetchFn: hawksVsPistonsFetch as any, env: mockEnv },
    );
    expect(injRes.success).toBe(true);
    expect(injRes.summary).toContain(
      'Summary: Atlanta Hawks (5 OUT, 0 Q) vs Detroit Pistons (5 OUT, 0 Q) | Health Balance: symmetric',
    );

    const compactedInj = compactInjurySummary(injRes.summary);
    expect(compactedInj).toContain('Health Balance: symmetric');
    expect(computeOutCountDiff(compactedInj)).toBe(0);

    const longMarketSummary =
      '[MARKET MOVEMENT: nba-401910029 | all] Current: home Atlanta Hawks ML +100 / away Detroit Pistons ML -118 | Open: home Atlanta Hawks ML +114 / away Detroit Pistons ML -134 | Steam: TOWARD home Atlanta Hawks ML (+114 -> +100, +3.3% imp) | AGAINST away Detroit Pistons ML (-134 -> -118)';
    const compactedMkt = compactMarketSummary(longMarketSummary);
    expect(compactedMkt).toContain('AGAINST away Detroit Pistons ML (-134 -> -118)');

    const formatted = formatUnifiedPerGameDossier(
      [
        {
          eventId: 'nba-401910029',
          matchup: 'Detroit Pistons @ Atlanta Hawks',
          sport: 'basketball_nba',
          injuries: compactedInj,
          market: compactedMkt,
          hasDirectionalSteam: true,
          outCountDiff: computeOutCountDiff(compactedInj),
          netMarginGap: 0,
        },
      ],
      1600,
    );
    expect(formatted.text).toContain('Health Balance: symmetric');
  });

  it('(3) auditCriticPremiseContradictions & auditClaimGrounding deterministically veto contra_steam_misread and symmetric_injury_misread while allowing accurate contrarian & clean picks', () => {
    const evidence = [
      'EVENT nba-401910029 Detroit Pistons @ Atlanta Hawks',
      '[INJURY & ROSTER DELTA: nba-401910029]',
      'Summary: Atlanta Hawks (5 OUT, 0 Q) vs Detroit Pistons (5 OUT, 0 Q) | Health Balance: symmetric',
      '- ATL: Trae Young: OUT; Jalen Johnson: OUT; Bogdan Bogdanovic: OUT; DeAndre Hunter: OUT; Clint Capela: OUT',
      '- DET: Cade Cunningham: OUT; Jaden Ivey: OUT; Tobias Harris: OUT; Ausar Thompson: OUT; Jalen Duren: OUT',
      '[MARKET MOVEMENT: nba-401910029 | ml] Current: home Atlanta Hawks ML +100 / away Detroit Pistons ML -118 | Steam: TOWARD home Atlanta Hawks ML (+114 -> +100, +3.3% imp) | AGAINST away Detroit Pistons ML (-134 -> -118)',
      'EVENT nba-401910032 Denver Nuggets @ Chicago Bulls',
      '[INJURY & ROSTER DELTA: nba-401910032]',
      'Summary: Chicago Bulls (3 OUT, 0 Q) vs Denver Nuggets (1 OUT, 0 Q) | Health Balance: away_advantage (Denver Nuggets)',
      '- CHI: Zach LaVine: OUT; Josh Giddey: OUT; Lonzo Ball: OUT',
      '- DEN: Aaron Gordon: OUT',
      '[MARKET MOVEMENT: nba-401910032 | spread] Current: away Denver Nuggets -10.5 (-110) / home Chicago Bulls +10.5 (-110) | Steam: TOWARD away Denver Nuggets (-8.5 -> -10.5, 2.0 pts) | AGAINST home Chicago Bulls (+8.5 -> +10.5)',
    ].join('\n');

    const badProposal = {
      picks: [
        {
          row: 'R1',
          event_id: 'nba-401910029',
          pick: 'Detroit Pistons ML',
          reason:
            'Market steam moves toward Detroit at +100, and Atlanta missing 5 rotation players creates a clear edge.',
        },
      ],
    };

    const premise = auditCriticPremiseContradictions(badProposal, evidence, SLATE_WF);
    expect(premise.pass).toBe(false);
    expect(premise.flags).toContain('contra_steam_misread');
    expect(premise.flags).toContain('symmetric_injury_misread');
    expect(premise.vetoedLegs?.some((v) => v.rowId === 'R1')).toBe(true);

    const fullAudit = auditClaimGrounding(badProposal, evidence, SLATE_WF);
    expect(fullAudit.pass).toBe(false);
    expect(fullAudit.flags).toContain('contra_steam_misread');
    expect(fullAudit.flags).toContain('symmetric_injury_misread');

    const contrarianAndCleanProposal = {
      picks: [
        {
          row: 'R1',
          event_id: 'nba-401910029',
          pick: 'Detroit Pistons ML',
          reason:
            'Despite market steam moving against Detroit toward Atlanta (+114 -> +100), both Detroit and Atlanta are missing 5 players (symmetric injuries), backing Detroit for matchup pace reasons.',
        },
        {
          row: 'R3',
          event_id: 'nba-401910032',
          pick: 'Denver Nuggets -10.5',
          reason:
            'Steam moved toward Denver (-8.5 -> -10.5) and Denver holds a clear health advantage with Chicago missing 3 players.',
        },
      ],
    };

    const cleanPremise = auditCriticPremiseContradictions(contrarianAndCleanProposal, evidence, SLATE_WF);
    expect(cleanPremise.pass).toBe(true);
    expect(cleanPremise.flags).toEqual([]);
  });

  it('(4) Risk Critic constants document veto policies and Stage 2 Critic execution deterministically forces pass:false & criticApproved:false even if LLM approves bad premises', async () => {
    for (const instr of [
      CRITIC_VERDICT_SYSTEM_INSTRUCTION,
      COMPACT_CRITIC_VERDICT_SYSTEM_INSTRUCTION,
    ]) {
      expect(instr).toContain('contra_steam_misread');
      expect(instr).toContain('symmetric_injury_misread');
    }
    expect(ANALYST_SYSTEM_INSTRUCTION).toContain(
      'never invert steam direction or claim an injury edge when Health Balance is symmetric',
    );
    expect(COMPACT_CRITIC_VERDICT_SYSTEM_INSTRUCTION.length).toBeLessThanOrEqual(1200);

    const headers = parseGameHeaders(SLATE_WF);
    const evidenceText = [
      '[INJURY & ROSTER DELTA: nba-401910029]',
      'Summary: Atlanta Hawks (5 OUT, 0 Q) vs Detroit Pistons (5 OUT, 0 Q) | Health Balance: symmetric',
      '- ATL: Trae Young: OUT; Jalen Johnson: OUT; Bogdan Bogdanovic: OUT; DeAndre Hunter: OUT; Clint Capela: OUT',
      '- DET: Cade Cunningham: OUT; Jaden Ivey: OUT; Tobias Harris: OUT; Ausar Thompson: OUT; Jalen Duren: OUT',
      '[MARKET MOVEMENT: nba-401910029 | ml]',
      'Current: home Atlanta Hawks ML +100 / away Detroit Pistons ML -118 | Steam: TOWARD home Atlanta Hawks ML (+114 -> +100, +3.3% imp) | AGAINST away Detroit Pistons ML (-134 -> -118)',
    ].join('\n');

    let capturedPrompt = '';
    const badPickProposal = {
      picks: [
        {
          row: 'R1',
          event_id: 'nba-401910029',
          pick: 'Detroit Pistons ML',
          reason: 'Market steam moves toward Detroit and Atlanta missing 5 rotation players.',
        },
      ],
    };

    const mockCriticAgent = new Agent('Risk Critic', 'mock-critic', 'groq', 'gsk_mock');
    vi.spyOn(mockCriticAgent, 'run').mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt;
      // Deliberately return bogus approval from LLM to prove deterministic Stage 2 override catches it
      return JSON.stringify({
        criticApproved: true,
        wageringPass: true,
        pass: true,
        verdict: 'Looks good to me.',
        flags: [],
      });
    });

    const registry = new ToolRegistry([
      {
        name: 'get_injury_and_roster_delta',
        description: 'inj',
        parameters: { game_id: { type: 'string', description: 'id', required: true } },
        execute: async () => ({ success: true, summary: evidenceText }),
      },
      {
        name: 'get_market_movement',
        description: 'mkt',
        parameters: { game_id: { type: 'string', description: 'id', required: true } },
        execute: async () => ({
          success: true,
          summary: evidenceText,
          data: { ml_away: -118, ml_home: 100 },
          markets_covered: ['ml'],
        }),
      },
    ]);

    const context = new SwarmContext();
    const proposedAuditContext = {
      summaryText: 'Proposed R1 Detroit Pistons ML.',
      proposedPicks: badPickProposal.picks,
      proposerReports: [
        {
          seat: 'Quant',
          picks: badPickProposal.picks,
          toolEvidenceItems: [
            { tool: 'get_injury_and_roster_delta', eventId: 'nba-401910029', summary: evidenceText },
            { tool: 'get_market_movement', eventId: 'nba-401910029', summary: evidenceText },
          ],
        },
      ],
    };
    const executor = createAnalystExecutor({
      task: 'Audit proposed pick.',
      chunks: [SLATE_WF],
      profile: {},
      historicalContext: '',
      targetAppId: 'test',
      context,
      toolRegistry: registry,
      analystClusterMap: new Map(),
      parsedHeaders: headers,
      curatedDossier: evidenceText,
      allGameIds: ['nba-401910029'],
    } as any);

    const criticResult: any = await executor(mockCriticAgent, SLATE_WF, 0, proposedAuditContext as any);
    expect(capturedPrompt).toContain('[Deterministic Pre-Check Flags]:');
    expect(capturedPrompt).toContain('contra_steam_misread');
    expect(capturedPrompt).toContain('symmetric_injury_misread');

    expect(criticResult.pass).toBe(false);
    expect(criticResult.criticApproved).toBe(false);
    expect(criticResult.flags).toContain('contra_steam_misread');
    expect(criticResult.flags).toContain('symmetric_injury_misread');
    expect(Array.isArray(criticResult.vetoedLegs)).toBe(true);
    expect(criticResult.vetoedLegs[0].rowId).toBe('R1');

    // Full cluster sanity check with mock agents for Nuggets clean pick passing Stage 1 & Stage 2
    const cleanHeaders = SLATE_WF;
    const manager = new Agent('Manager', 'mock-mgr', 'openrouter', 'sk-mock');
    const quant = new Agent('Quant Analyst', 'mock-q', 'groq', 'gsk_mock');
    const critic = new Agent('Risk Critic', 'mock-c', 'groq', 'gsk_mock');
    vi.spyOn(quant, 'run').mockResolvedValue(
      JSON.stringify({
        summary: 'Backing R3 Denver Nuggets -10.5 with Chicago missing 3 players and Denver steam.',
        picks: [
          {
            row: 'R3',
            event_id: 'nba-401910032',
            pick: 'Denver Nuggets -10.5',
            reason: 'Chicago missing 3 players (3 OUT vs Denver 1 OUT); steam moved toward Denver (-8.5 -> -10.5).',
          },
        ],
      }),
    );
    vi.spyOn(critic, 'run').mockResolvedValue(
      JSON.stringify({ criticApproved: true, wageringPass: true, pass: true, verdict: 'Approved R3 Denver Nuggets -10.5.', flags: [] }),
    );
    vi.spyOn(manager, 'run').mockResolvedValue(
      JSON.stringify({
        summary: 'Approved R3 Denver Nuggets -10.5.',
        picks: [
          {
            row: 'R3',
            event_id: 'nba-401910032',
            pick: 'Denver Nuggets -10.5',
            reason: 'Chicago missing 3 players; steam moved toward Denver.',
          },
        ],
        components: [],
      }),
    );

    const clusterReg = new ToolRegistry([
      {
        name: 'get_injury_and_roster_delta',
        description: 'inj',
        parameters: { game_id: { type: 'string', description: 'id', required: true } },
        execute: async () => ({
          success: true,
          summary:
            '[INJURY & ROSTER DELTA: nba-401910032]\nSummary: Chicago Bulls (3 OUT, 0 Q) vs Denver Nuggets (1 OUT, 0 Q) | Health Balance: away_advantage (Denver Nuggets)\n- CHI: Zach LaVine: OUT; Josh Giddey: OUT; Lonzo Ball: OUT\n- DEN: Aaron Gordon: OUT',
        }),
      },
      {
        name: 'get_market_movement',
        description: 'mkt',
        parameters: { game_id: { type: 'string', description: 'id', required: true } },
        execute: async () => ({
          success: true,
          summary:
            '[MARKET MOVEMENT: nba-401910032 | spread] Current: away Denver Nuggets -10.5 (-110) / home Chicago Bulls +10.5 (-110) | Steam: TOWARD away Denver Nuggets (-8.5 -> -10.5, 2.0 pts) | AGAINST home Chicago Bulls (+8.5 -> +10.5)',
          data: { spread_home: 10.5, spread_away: -10.5 },
          markets_covered: ['spread'],
        }),
      },
    ]);

    const clusterOut = await runClusterPipeline({
      task: 'Recommend best grounded NBA spread pick.',
      data: cleanHeaders,
      analysts: [quant, critic],
      managerAgent: manager,
      chunks: [cleanHeaders],
      profile: {},
      rawInput: cleanHeaders,
      historicalContext: '',
      targetAppId: 'test',
      context: new SwarmContext(),
      toolRegistry: clusterReg,
      params: {} as any,
      optimizationEnabled: false,
      coordinationEnabled: false,
      bypassCache: true,
    });
    const flatReports = clusterOut.allAnalystReports.flat();
    const quantReport = flatReports.find((r: any) => Array.isArray(r?.picks) && r.picks.length > 0);
    expect(quantReport?.picks[0]?.pick).toContain('Denver Nuggets');
    const criticReport = flatReports.find((r: any) => typeof r?.criticApproved === 'boolean' || typeof r?.pass === 'boolean');
    expect(criticReport?.pass).toBe(true);
  });
});
