import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { executeManagerSynthesis } from '../swarm/engine/synthesisPipeline.ts';
import { runDeepAnalysisVerification } from '../swarm/engine/verificationPipeline.ts';
import {
  guardManagerResponse,
  guardAnalystResponse,
  stripApproximateOdds,
} from '../swarm/parser/responseGuards.ts';
import { ANALYST_SYSTEM_INSTRUCTION } from '../swarm/engine/constants.ts';
import {
  auditMarketCoverageAndRowBinding,
  checkNhlPucklinePriceBand,
  extractRowOptions,
} from '../swarm/tools/marketRowBinding.ts';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';
import {
  formatUnifiedPerGameDossier,
  evaluateQualitativePillars,
  type UnifiedGameDossierEntry,
} from '../swarm/engine/unifiedDossier.ts';
import { seatBudget } from '../swarm/context/promptBudget.ts';
import { TokenEstimator } from '../swarm/compression/tokenEstimator.ts';
import {
  getMatchupFundamentalsTool,
  getInjuryAndRosterDeltaTool,
  scoreInjuryStarterTier,
} from '../swarm/tools/dueloddsRpcTools.ts';

const mockEnv = {
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_ANON_KEY: 'mock-anon-key',
};

describe('wf-1795618886150 regressions (S1 & S2)', () => {
  it('S1.1: final compiled payload ALWAYS includes typeof criticApproved === "boolean" (true on approve, false on veto/unverified)', async () => {
    const directGuarded = guardManagerResponse(
      JSON.stringify({
        ui_title: '2-Leg Parlay',
        summary: 'Bottom-line call: play R1 + R111.',
        components: [],
        picks: [{ row: 'R1', side: 'Home -3.5' }],
        scorecards: [{ seat: 'Risk Critic', verdict: 'approve', notes: 'All checks passed.' }],
      }),
      'GodView Compiler',
    );
    expect(typeof (directGuarded as any).criticApproved).toBe('boolean');
    expect((directGuarded as any).criticApproved).toBe(true);

    const managerAgent = {
      id: 'manager',
      role: 'GodView Compiler',
      provider: 'gemini',
      modelName: 'gemini-2.5-flash',
      setSystemInstruction: vi.fn(),
      run: vi.fn(async () =>
        JSON.stringify({
          ui_title: 'Verified Play',
          summary: 'Bottom-line call: Carolina Hurricanes ML (R111) supported.',
          components: [],
          picks: [{ row: 'R111', event_id: 'nhl-401892783', side: 'Carolina Hurricanes ML', reason: 'Steam + form' }],
          scorecards: [{ seat: 'Risk Critic', verdict: 'approve', notes: 'Clean.' }],
        }),
      ),
    } as unknown as Agent;

    const synthApproved = await executeManagerSynthesis(
      managerAgent,
      'Game Slate:\nevent_id=nhl-401892783 | sport=icehockey_nhl | Columbus Blue Jackets @ Carolina Hurricanes | options: R111 ML Carolina Hurricanes ML(-128)',
      new SwarmContext(),
      undefined,
      true,
      undefined,
      ['nhl-401892783'],
      {
        toolResults: '[MARKET MOVEMENT: nhl-401892783] ml_home=-128 ml_away=+108',
        criticVerdictApproved: true,
      },
    );
    expect(typeof synthApproved.criticApproved).toBe('boolean');
    expect(synthApproved.criticApproved).toBe(true);

    const criticVetoAgent = {
      id: 'critic',
      role: 'Risk Critic',
      provider: 'groq',
      modelName: 'llama-3.3-70b-versatile',
      setSystemInstruction: vi.fn(),
      run: vi.fn(async () =>
        JSON.stringify({
          pass: false,
          criticApproved: false,
          verdict: 'Vetoed R111 due to late goalie scratch.',
          flags: ['fatal_scratch'],
        }),
      ),
    } as unknown as Agent;

    const verifiedFail = await runDeepAnalysisVerification({
      task: 'Compile best play',
      rawInput: 'event_id=nhl-401892783 | sport=icehockey_nhl | Columbus Blue Jackets @ Carolina Hurricanes | options: R111 ML Carolina Hurricanes ML(-128)',
      effectiveDynamicPrompt: 'Compile best play',
      effectiveCompiledReports: '[Quant]: R111',
      effectiveHistoricalContext: '',
      managerAgent,
      analysts: [],
      dedicatedCriticAgent: criticVetoAgent,
      context: new SwarmContext(),
      criticVerdictApproved: false,
    });
    expect(typeof verifiedFail.finalAnalysis.criticApproved).toBe('boolean');
    expect(verifiedFail.finalAnalysis.criticApproved).toBe(false);
  });

  it('S1.2: NHL -1.5 puckline (+205) vs ML (-128) guidance is in ANALYST_SYSTEM_INSTRUCTION and deterministic price-band check flags R47 over R111', () => {
    expect(ANALYST_SYSTEM_INSTRUCTION).toContain('-1.5 pucklines');
    expect(ANALYST_SYSTEM_INSTRUCTION).toContain('-220');
    expect(ANALYST_SYSTEM_INSTRUCTION).toContain('+150');
    expect(ANALYST_SYSTEM_INSTRUCTION).toContain('NHL Moneyline');

    const nhlSlate =
      'event_id=nhl-401892783 | sport=icehockey_nhl | Columbus Blue Jackets @ Carolina Hurricanes | commence=2099-11-25T00:00:00Z | options: R47 SPR Carolina Hurricanes -1.5 (+205), R48 SPR Columbus Blue Jackets +1.5 (-250), R111 ML Carolina Hurricanes ML (-128), R112 ML Columbus Blue Jackets ML (+108)';
    const headers = parseGameHeaders(nhlSlate);
    const rowMap = extractRowOptions([nhlSlate], headers);

    const pucklineCheck = checkNhlPucklinePriceBand(
      { row: 'R47', event_id: 'nhl-401892783', side: 'Carolina Hurricanes -1.5' },
      rowMap,
    );
    expect(pucklineCheck.outOfBand).toBe(true);
    expect(pucklineCheck.odds).toBe(205);
    expect(pucklineCheck.preferredMlRowId).toBe('R111');
    expect(pucklineCheck.preferredMlOdds).toBe(-128);

    const badProposal = {
      picks: [
        {
          row: 'R47',
          event_id: 'nhl-401892783',
          side: 'Carolina Hurricanes -1.5',
          reason: 'Sits comfortably inside the -220 to +150 optimal price band.',
        },
      ],
    };
    const audit = auditMarketCoverageAndRowBinding(
      badProposal,
      '[MARKET MOVEMENT: nhl-401892783] Current: home Carolina Hurricanes -1.5 (+205) / ml_home=-128',
      nhlSlate,
      headers,
    );
    expect(audit.pass).toBe(false);
    expect(audit.flags).toContain('price_band_misread');
    expect(audit.feedback).toContain('R111');

    const goodProposal = {
      picks: [
        {
          row: 'R111',
          event_id: 'nhl-401892783',
          side: 'Carolina Hurricanes ML',
          reason: 'Sits inside the -220 to +150 optimal price band.',
        },
      ],
    };
    const goodAudit = auditMarketCoverageAndRowBinding(
      goodProposal,
      '[MARKET MOVEMENT: nhl-401892783] Current: home Carolina Hurricanes ML (-128) / ml_home=-128',
      nhlSlate,
      headers,
    );
    expect(goodAudit.pass).toBe(true);
  });

  it('S1.3: digest odds scrubber preserves policy price-band ranges and never produces "in the to range" or "within the / window"', () => {
    const prose =
      'Both spreads sit in the -110 to -120 range, well within the -220/+150 window. Pick R1 at -110 with steam (-144 -> -172).';
    const cleaned = stripApproximateOdds(prose);
    expect(cleaned).not.toContain('in the to range');
    expect(cleaned).not.toContain('within the / window');
    expect(cleaned).toContain('-110 to -120 range');
    expect(cleaned).toContain('-220/+150 window');
    expect(cleaned).not.toContain('at -110');
    expect(cleaned).not.toContain('-144');
    expect(cleaned).not.toContain('-172');

    const guarded = guardAnalystResponse(
      JSON.stringify({
        insights: ['Both spreads sit in the -110 to -120 range, well within the -220/+150 window.'],
        anomalies: [],
        summary: 'Pricing stays in the -220 to +150 optimal band.',
      }),
      'Quant Proposer',
    );
    expect(guarded.insights[0]).toContain('-110 to -120 range');
    expect(guarded.insights[0]).toContain('-220/+150 window');
    expect(guarded.insights[0]).not.toContain('in the to range');
    expect(guarded.insights[0]).not.toContain('within the / window');
    expect(guarded.summary).toContain('-220 to +150');
  });

  it('S2.1: 20-game (120 R-ID) slate caps full dossier sections to <= 10 with compact 1-line summaries and keeps a2 dossierTruncated === false', () => {
    const makeEntry = (
      idx: number,
      opts: { aligned?: number; uncertainQ?: boolean; netGap?: number } = {},
    ): UnifiedGameDossierEntry => {
      const id = idx % 2 === 0 ? `nba-4019101${String(idx).padStart(2, '0')}` : `nhl-4018927${String(idx).padStart(2, '0')}`;
      const isNhl = id.startsWith('nhl-');
      const netGap = opts.netGap ?? (opts.aligned && opts.aligned >= 2 ? (isNhl ? 1.8 : 9.0) : 0.1);
      const fund = `Home (H${idx}): W-L ${opts.aligned ? '8-2' : '5-5'} | PF/PA ${isNhl ? '3.5 / 2.0' : '118.0 / 109.0'} | Net Margin ${netGap} | Away (A${idx}): W-L ${opts.aligned ? '2-8' : '5-5'} | PF/PA ${isNhl ? '2.1 / 3.4' : '109.0 / 118.0'} | Net Margin -${netGap}`;
      const inj = opts.uncertainQ
        ? `Summary: Home ${idx} (1 OUT, 3 Q) vs Away ${idx} (0 OUT, 2 Q) | Health Balance: uncertain_questionable (Home ${idx}: 3 Q)\n- H${idx}: Star: QUESTIONABLE`
        : opts.aligned && opts.aligned >= 2
          ? `Summary: Home ${idx} (0 OUT, 0 Q) vs Away ${idx} (3 OUT, 0 Q) | Health Balance: home_advantage (Home ${idx})\n- A${idx}: Starter 1: OUT; Starter 2: OUT; Starter 3: OUT`
          : `Summary: Home ${idx} (1 OUT, 0 Q) vs Away ${idx} (1 OUT, 0 Q) | Health Balance: symmetric`;
      const mkt =
        opts.aligned && opts.aligned >= 3
          ? `Spread: Open -3.5 -> Latest -5.5 | Steam: TOWARD Home ${idx} | AGAINST Away ${idx} | Books: 3`
          : `Spread: Open -1.5 -> Latest -1.5 | Steam: NEUTRAL | Books: 1`;
      return {
        eventId: id,
        matchup: `Away ${idx} @ Home ${idx}`,
        sport: isNhl ? 'icehockey_nhl' : 'basketball_nba',
        rows: `R${idx * 6 + 1}:SPR Home ${idx} -3.5 | R${idx * 6 + 2}:SPR Away ${idx} +3.5 | R${idx * 6 + 3}:ML Home ${idx} ML | R${idx * 6 + 4}:ML Away ${idx} ML | R${idx * 6 + 5}:TOT Over 220.5 | R${idx * 6 + 6}:TOT Under 220.5`,
        fundamentals: fund,
        injuries: inj,
        market: mkt,
        hasDirectionalSteam: Boolean(opts.aligned && opts.aligned >= 3),
        outCountDiff: opts.aligned && opts.aligned >= 2 ? 3 : 0,
        netMarginGap: netGap * 2,
      };
    };

    // Build 20 games: indices 0..1 are uncertain_questionable / 0-pillar, indices 10..19 are 2-3 aligned pillar games
    const entries: UnifiedGameDossierEntry[] = [
      makeEntry(0, { aligned: 0, uncertainQ: true }),
      makeEntry(1, { aligned: 0 }),
      ...Array.from({ length: 8 }, (_, k) => makeEntry(k + 2, { aligned: 0 })),
      ...Array.from({ length: 6 }, (_, k) => makeEntry(k + 10, { aligned: 2 })),
      ...Array.from({ length: 4 }, (_, k) => makeEntry(k + 16, { aligned: 3 })),
    ];
    expect(entries).toHaveLength(20);

    const nvidiaRoom = seatBudget('nvidia').maxPromptChars - 9000;
    const cloudflareRoom = seatBudget('cloudflare').maxPromptChars - 8500;
    const a1Out = formatUnifiedPerGameDossier(entries, nvidiaRoom);
    const a2Out = formatUnifiedPerGameDossier(entries, cloudflareRoom);

    const a1FullCount = (a1Out.text.match(/=== GAME DOSSIER:/g) || []).length;
    expect(a1FullCount).toBeLessThanOrEqual(10);
    expect(a1Out.fullSectionsIncluded).toBeLessThanOrEqual(10);
    expect(a1Out.sectionsIncluded).toBe(20);
    expect(a1Out.truncated).toBe(false);
    expect(a1Out.text).toContain('=== REMAINING SLATE (COMPACT SUMMARIES) ===');
    expect(TokenEstimator.estimatePayloadTokens(a1Out.text)).toBeLessThan(6000);

    // 3-pillar games appear in full dossiers; uncertain_questionable & 0-pillar games appear in compact summaries
    expect(a1Out.text).toContain(`=== GAME DOSSIER: ${entries[19].eventId}`);
    const compactSection = a1Out.text.split('=== REMAINING SLATE (COMPACT SUMMARIES) ===')[1] || '';
    expect(compactSection).toContain(entries[0].eventId);
    expect(compactSection).toContain(entries[1].eventId);

    const a2FullCount = (a2Out.text.match(/=== GAME DOSSIER:/g) || []).length;
    expect(a2FullCount).toBeLessThanOrEqual(10);
    expect(a2Out.truncated).toBe(false);
    expect(a2Out.sectionsIncluded).toBe(20);
  });

  it('S2.2: get_injury_and_roster_delta recognizes espn_depthchart starter rows with Tier-1 weights (QB1=5.0, LT/G=4.0, NBA starter=3.0)', async () => {
    const qbScore = scoreInjuryStarterTier(
      { player_id: 'qb1', player_name: 'Star QB', team_abbr: 'BUF', status: 'OUT' },
      [{ source: 'espn_depthchart', player_id: 'qb1', stats: { position: 'QB', depth_rank: 1, starter: true } }],
      'americanfootball_nfl',
    );
    expect(qbScore).toMatchObject({ tier: 1, weight: 5.0, starter: true, source: 'espn_depthchart' });

    const ltScore = scoreInjuryStarterTier(
      { player_id: 'lt1', player_name: 'Blindside LT', team_abbr: 'BUF', status: 'OUT' },
      [{ source: 'espn_depthchart', player_id: 'lt1', stats: { position: 'LT', depth_rank: 1, starter: true } }],
      'americanfootball_nfl',
    );
    expect(ltScore).toMatchObject({ tier: 1, weight: 4.0, starter: true, source: 'espn_depthchart' });

    const nhlGoalieScore = scoreInjuryStarterTier(
      { player_id: 'g1', player_name: 'Starting Goalie', team_abbr: 'CAR', status: 'OUT' },
      [{ source: 'espn_depthchart', player_id: 'g1', stats: { position: 'G', depth_rank: 1, starter: true } }],
      'icehockey_nhl',
    );
    expect(nhlGoalieScore).toMatchObject({ tier: 1, weight: 4.0, starter: true, source: 'espn_depthchart' });

    const nbaStarterScore = scoreInjuryStarterTier(
      { player_id: 'pg1', player_name: 'Preseason Out Guard', team_abbr: 'BOS', status: 'OUT' },
      [{ source: 'espn_depthchart', player_id: 'pg1', stats: { position: 'PG', depth_rank: 1, starter: true } }],
      'basketball_nba',
    );
    expect(nbaStarterScore).toMatchObject({ tier: 2, weight: 1.5, starter: true, source: 'espn_depthchart' });

    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          game_id: 'nfl-401873099',
          sport: 'americanfootball_nfl',
          home_team: 'Buffalo Bills',
          away_team: 'Miami Dolphins',
          injuries: [
            { player_id: 'qb1', team_abbr: 'BUF', player_name: 'Josh Allen', status: 'OUT' },
            { player_id: 'wr4', team_abbr: 'BUF', player_name: 'Depth WR', status: 'OUT' },
          ],
          player_game_logs: [
            { source: 'espn_depthchart', player_id: 'qb1', stats: { position: 'QB', depth_rank: 1, starter: true } },
            { source: 'espn_depthchart', player_id: 'wr4', stats: { position: 'WR', depth_rank: 4, starter: false } },
          ],
        }),
        { status: 200 },
      ),
    );

    const res = await (getInjuryAndRosterDeltaTool as any).execute(
      { game_id: 'nfl-401873099' },
      { fetchFn: mockFetch as any, env: mockEnv },
    );
    expect(res.success).toBe(true);
    const qbInj = res.data.injuries.find((i: any) => i.player_id === 'qb1');
    expect(qbInj.impact_tier).toBe(1);
    expect(qbInj.impact_weight).toBe(5.0);
    expect(qbInj.starter).toBe(true);
    expect(res.summary).toContain('Josh Allen (QB): OUT [T1 5.0]');
  });

  it('S2.3: get_matchup_fundamentals deduplicates WAS/WSH H2H rows by (game_date, sorted_scores)', async () => {
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          game_id: 'nhl-401892787',
          sport: 'icehockey_nhl',
          home: { team: 'PHI', wins: 5, losses: 5, points_for_avg: 2.9, points_against_avg: 3.1, net_margin: -0.2 },
          away: { team: 'WSH', wins: 6, losses: 4, points_for_avg: 3.4, points_against_avg: 2.6, net_margin: 0.8 },
          h2h: [
            { game_date: '2026-10-28', team_abbr: 'PHI', opponent_abbr: 'WAS', team_score: 2, opponent_score: 5, result: 'L' },
            { game_date: '2026-10-28', team_abbr: 'WSH', opponent_abbr: 'PHI', team_score: 5, opponent_score: 2, result: 'W' },
          ],
        }),
        { status: 200 },
      ),
    );

    const res = await (getMatchupFundamentalsTool as any).execute(
      { game_id: 'nhl-401892787' },
      { fetchFn: mockFetch as any, env: mockEnv },
    );
    expect(res.success).toBe(true);
    const h2hLine = String(res.summary).split('\n').find((l: string) => l.startsWith('H2H:')) || '';
    expect(h2hLine).toBe('H2H: 2026-10-28: WSH vs PHI 5-2 (W)');
    expect(h2hLine).not.toContain('PHI vs WAS');
  });
});
