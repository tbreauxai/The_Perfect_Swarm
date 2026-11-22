import { describe, it, expect, vi } from 'vitest';
import {
  fetchTwoHopSlateDossier,
  formatCompactDossierRows,
  formatUnifiedPerGameDossier,
} from '../swarm/engine/unifiedDossier.ts';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';
import { GameQueryCache } from '../swarm/cache/gameQueryCache.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { auditMarketCoverageAndRowBinding } from '../swarm/tools/marketRowBinding.ts';
import {
  auditCriticPremiseContradictions,
  sanitizeUngroundedClaims,
} from '../swarm/tools/claimGrounding.ts';
import { syncCompilerProseWithFinalPicks } from '../swarm/tools/compilerProseSync.ts';
import { guardAnalystResponse, stripApproximateOdds } from '../swarm/parser/responseGuards.ts';
import { getMarketMovementTool } from '../swarm/tools/dueloddsRpcTools.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { SwarmContext } from '../swarm/context.ts';

const SLATE_WF_377 = [
  'event_id=nba-401910032 | sport=basketball_nba | Chicago Bulls @ Denver Nuggets | commence=2099-11-23T01:00:00Z | options: R42 SPR Chicago Bulls +10.5 (-110), R43 SPR Denver Nuggets -10.5 (-110), R44 TOT Over 236.5 (-110), R45 TOT Under 236.5 (-110), R66 ML Denver Nuggets (-450), R86 ML Chicago Bulls (+350)',
  'event_id=nhl-401892770 | sport=icehockey_nhl | Edmonton Oilers @ St. Louis Blues | commence=2099-11-23T01:00:00Z | options: R62 ML St. Louis Blues (-126), R78 ML Edmonton Oilers (+105)',
  'event_id=nba-401910036 | sport=basketball_nba | Charlotte Hornets @ Miami Heat | commence=2099-11-23T00:30:00Z | options: R65 ML Miami Heat (-172), R68 ML Charlotte Hornets (+144)',
  'event_id=nba-401910034 | sport=basketball_nba | Indiana Pacers @ New York Knicks | commence=2099-11-23T00:00:00Z | options: R55 SPR New York Knicks -7.5 (-110), R56 SPR Indiana Pacers +7.5 (-110)',
].join('\n');

describe('wf-1795373843477 P0-2 & P0-3 Regressions', () => {
  it('P0-2 (1): unified per-game dossier block for nba-401910032 includes inline Rows: with R43 and R66 without odds bloat', async () => {
    const headers = parseGameHeaders(SLATE_WF_377);
    const compactRows = formatCompactDossierRows(headers[0]);
    expect(compactRows).toContain('R43:');
    expect(compactRows).toContain('R66:');
    expect(compactRows).not.toContain('(-110)');
    expect(compactRows).not.toContain('(-450)');

    const reg = new ToolRegistry([
      {
        name: 'get_matchup_fundamentals',
        description: 'fund',
        parameters: { game_id: { type: 'string', description: 'Event ID' } },
        execute: async ({ game_id }: any) => ({
          success: true,
          summary: `[MATCHUP FUNDAMENTALS: ${game_id} (L10)] Home (DEN): W-L 8-2 | Net Margin 9.8 | L5: 4-1 | Away (CHI): W-L 3-7 | Net Margin -7.8 | L5: 1-4`,
        }),
      },
      {
        name: 'get_injury_and_roster_delta',
        description: 'inj',
        parameters: { game_id: { type: 'string', description: 'Event ID' } },
        execute: async () => ({
          success: true,
          summary: 'Summary: Denver Nuggets (0 OUT, 0 Q) vs Chicago Bulls (2 OUT, 1 Q) | Health Balance: home_advantage (Denver Nuggets)',
        }),
      },
      {
        name: 'get_market_movement',
        description: 'mkt',
        parameters: { game_id: { type: 'string', description: 'Event ID' } },
        execute: async () => ({
          success: true,
          summary: 'Steam: TOWARD home Denver Nuggets (-8.5 -> -10.5, 2.0 pts) | AGAINST away Chicago Bulls (+8.5 -> +10.5)',
        }),
      },
    ]);

    const dossier = await fetchTwoHopSlateDossier(
      headers.slice(0, 1),
      reg,
      new GameQueryCache(),
      new SwarmContext(),
    );
    const formatted = formatUnifiedPerGameDossier(dossier.entries);
    const denverIdx = formatted.text.indexOf('=== GAME DOSSIER: nba-401910032');
    expect(denverIdx).toBeGreaterThanOrEqual(0);
    const linesAfterHeader = formatted.text.slice(denverIdx).split('\n');
    expect(linesAfterHeader[1]).toMatch(/^Rows:\s+.*R43:.*R66:/);
  });

  it('P0-2 (2): { row: "R78", side: "Denver Nuggets" } triggers row_side_mismatch BEFORE contra_steam_misread or tainting R62', () => {
    const headers = parseGameHeaders(SLATE_WF_377);
    const evidence = [
      '[MARKET MOVEMENT: nhl-401892770] Steam: TOWARD home St. Louis Blues ML (-111 -> -126, +3.6pp implied) | AGAINST away Edmonton Oilers ML (+101 -> +105)',
      '[MARKET MOVEMENT: nba-401910032] Steam: TOWARD home Denver Nuggets (-8.5 -> -10.5, 2.0 pts) | AGAINST away Chicago Bulls (+8.5 -> +10.5)',
      '[INJURY & ROSTER DELTA: nhl-401892770] Summary: St. Louis Blues (1 OUT, 0 Q) vs Edmonton Oilers (2 OUT, 0 Q) | Health Balance: home_advantage (St. Louis Blues)',
    ].join('\n');

    const proposal = {
      picks: [
        {
          row: 'R62',
          event_id: 'nhl-401892770',
          side: 'St. Louis Blues ML',
          reason: 'Backed by favorable market steam toward St. Louis Blues and healthier lineup.',
        },
        {
          row: 'R78',
          side: 'Denver Nuggets',
          reasonSource: 'nba-401910032',
          reason: 'Supported by favorable steam toward Denver Nuggets.',
        },
      ],
    };

    const premiseAudit = auditCriticPremiseContradictions(proposal, evidence, SLATE_WF_377, { headers });
    expect(premiseAudit.pass).toBe(false);
    expect(premiseAudit.flags).toContain('row_side_mismatch');
    expect(premiseAudit.flags).not.toContain('contra_steam_misread');
    expect(premiseAudit.flags).not.toContain('duplicate_leg');
    expect(premiseAudit.violations.some((v) => /R78/.test(v))).toBe(true);
    expect(premiseAudit.violations.some((v) => /contra_steam_misread/i.test(v))).toBe(false);
    expect(premiseAudit.vetoedLegs?.some((leg) => leg.rowId === 'R78')).toBe(true);
    expect(premiseAudit.vetoedLegs?.some((leg) => leg.rowId === 'R62')).toBe(false);

    const marketAudit = auditMarketCoverageAndRowBinding(proposal, evidence, SLATE_WF_377, headers);
    expect(marketAudit.pass).toBe(false);
    expect(marketAudit.flags).toContain('row_side_mismatch');
    expect(marketAudit.vetoedLegs?.[0]?.rowId).toBe('R78');
  });

  it('P0-3 (3): syncCompilerProseWithFinalPicks reconciles picks[], insights[], summary, and analysis after pruning R55 and passes Rule 6 on Attempt 1', async () => {
    const headers = parseGameHeaders(SLATE_WF_377);
    const compilerPayload: any = {
      ui_title: '3-Leg Multi-Sport Parlay',
      summary:
        '3-leg parlay: St. Louis Blues ML (R62) + Miami Heat ML (R65) + New York Knicks -7.5 (R55).',
      analysis:
        'Building a 3-leg parlay around St. Louis Blues ML (R62), Miami Heat ML (R65), and New York Knicks -7.5 (R55). Knicks -7.5 adds third leg despite 2-point contra-steam.',
      picks: [
        { row: 'R62', side: 'St. Louis Blues ML', reason: 'Strong home form and ML steam.' },
        { row: 'R65', side: 'Miami Heat ML', reason: 'ML steam toward Heat (-144 -> -172).' },
      ],
      components: [
        {
          id: 'default-insight-list',
          type: 'InsightList',
          props: {
            insights: [
              { message: '[R62] St. Louis Blues ML — Strong home form and ML steam.', type: 'positive' },
              { message: '[R65] Miami Heat ML — ML steam toward Heat.', type: 'positive' },
              { message: '[R55] New York Knicks -7.5 — Home favorite leg.', type: 'neutral' },
            ],
          },
        },
      ],
    };

    const res = syncCompilerProseWithFinalPicks(compilerPayload, {
      initialPicks: [
        { row: 'R62', side: 'St. Louis Blues ML' },
        { row: 'R65', side: 'Miami Heat ML' },
        { row: 'R55', side: 'New York Knicks -7.5' },
      ],
      headers,
      slateText: SLATE_WF_377,
    });

    expect(res.synced).toBe(true);
    expect(compilerPayload.picks).toHaveLength(2);
    expect(compilerPayload.components[0].props.insights).toHaveLength(2);
    const insightText = JSON.stringify(compilerPayload.components[0].props.insights);
    expect(insightText).toContain('R62');
    expect(insightText).toContain('R65');
    expect(insightText).not.toContain('R55');
    expect(insightText).not.toContain('Knicks');
    expect(compilerPayload.summary).not.toContain('R55');
    expect(compilerPayload.summary).not.toMatch(/3-leg parlay/i);
    expect(compilerPayload.summary).toMatch(/2-leg parlay/i);
    expect(compilerPayload.analysis).not.toContain('R55');
    expect(compilerPayload.analysis).not.toMatch(/3-leg parlay/i);

    // 2-leg -> 1-leg prune becomes single-leg play
    const oneLegPayload: any = {
      summary: '2-leg parlay: St. Louis Blues ML (R62) + Miami Heat ML (R65).',
      analysis: '2-leg parlay across R62 and R65.',
      picks: [{ row: 'R62', side: 'St. Louis Blues ML', reason: 'Blues ML steam.' }],
    };
    syncCompilerProseWithFinalPicks(oneLegPayload, {
      initialPicks: [{ row: 'R62', side: 'St. Louis Blues ML' }, { row: 'R65', side: 'Miami Heat ML' }],
      headers,
      slateText: SLATE_WF_377,
    });
    expect(oneLegPayload.summary).toMatch(/single-leg play/i);
    expect(oneLegPayload.summary).not.toContain('R65');

    // Lifecycle Attempt 1 scenario: uncovered leg R55 pruned before Verification Critic sees Attempt 1
    let capturedVerifyPrompt = '';
    const proposer: any = {
      role: 'Manager',
      provider: 'openrouter',
      modelName: 'mock-m',
      run: vi.fn(async () =>
        JSON.stringify({
          summary: '3-leg parlay: St. Louis Blues ML (R62) + Miami Heat ML (R65) + New York Knicks -7.5 (R55).',
          analysis: '3-leg parlay with R62, R65, and R55.',
          picks: [
            { row: 'R62', event_id: 'nhl-401892770', side: 'St. Louis Blues ML', reason: 'Strong home form.' },
            { row: 'R65', event_id: 'nba-401910036', side: 'Miami Heat ML', reason: 'Home steam toward Heat.' },
            { row: 'R55', event_id: 'nba-401910034', side: 'New York Knicks -7.5', reason: 'Knicks favorite.' },
          ],
          components: [
            {
              id: 'default-insight-list',
              type: 'InsightList',
              props: {
                insights: [
                  { message: '[R62] St. Louis Blues ML — Strong home form.', type: 'positive' },
                  { message: '[R65] Miami Heat ML — Home steam toward Heat.', type: 'positive' },
                  { message: '[R55] New York Knicks -7.5 — Knicks favorite.', type: 'neutral' },
                ],
              },
            },
          ],
        }),
      ),
    };
    const critic: any = {
      role: 'Verification Critic',
      provider: 'openrouter',
      modelName: 'mock-c',
      run: vi.fn(async (prompt: string) => {
        capturedVerifyPrompt = prompt;
        expect(prompt).not.toContain('R55');
        expect(prompt).not.toMatch(/3-leg parlay/i);
        expect(prompt).toMatch(/2-leg parlay/i);
        return JSON.stringify({
          pass: true,
          feedback: 'Verified St. Louis Blues ML (R62) and Miami Heat ML (R65) 1:1 with picks[].',
        });
      }),
    };

    const lifecycle = new AnalysisLifecycle(proposer, critic, 2);
    const lifecycleRes = await lifecycle.executeAndVerify(
      {
        fullBoard: SLATE_WF_377,
        allHeaders: headers,
        toolResults: [
          'EVENT nhl-401892770 | St. Louis Blues ML -126 | Home L5: 4-1 | Steam: TOWARD home St. Louis Blues ML (-111 -> -126, +3.6pp implied)',
          'EVENT nba-401910036 | Miami Heat ML -172 | Home L5: 4-1 | Steam: TOWARD home Miami Heat ML (-144 -> -172, +4.2pp implied)',
        ].join('\n'),
      },
      new SwarmContext(),
      'Compile 3-leg parlay',
      'Verify 1:1 consistency with picks[]',
      ['nhl-401892770', 'nba-401910036'],
    );

    expect(capturedVerifyPrompt.length).toBeGreaterThan(0);
    expect(lifecycleRes.success).toBe(true);
    expect(lifecycleRes.attempts).toBe(1);
    expect(lifecycleRes.finalProposal.picks).toHaveLength(2);
    expect(lifecycleRes.finalProposal.components[0].props.insights).toHaveLength(2);
  });

  it('P0-3 (4): specialist digest sanitizer preserves "1) DEN -10.5 (R43)" and leaves zero "( -> )" / "( → )" artifacts', () => {
    const asciiDigest =
      '1) DEN -10.5 (R43): DEN 4-1 L5; steam TOWARD DEN (-8.5 -> -10.5). 2) MIA ML (R65): steam TOWARD MIA ML (-144 -> -172).';
    const unicodeDigest =
      '1) DEN -10.5 (R43): DEN 4-1 L5; steam TOWARD DEN (-8.5 → -10.5). 2) MIA ML (R65): steam TOWARD MIA ML (-144 → -172).';

    for (const digest of [asciiDigest, unicodeDigest]) {
      const cleaned = stripApproximateOdds(digest);
      expect(cleaned).toContain('1) DEN -10.5 (R43): DEN 4-1 L5');
      expect(cleaned).not.toMatch(/\(\s*(?:->|→)?\s*\)/);
      expect(cleaned).toMatch(/DEN \(-8\.5 (?:->|→) -10\.5\)/);

      const guarded = guardAnalystResponse(
        JSON.stringify({
          insights: [digest],
          anomalies: [],
          summary: digest,
          picks: [{ row: 'R43', side: 'DEN -10.5', reason: digest }],
        }),
        'Quant Proposer',
      );
      expect(guarded.insights[0]).toContain('1) DEN -10.5 (R43)');
      expect(guarded.insights[0]).not.toMatch(/\(\s*(?:->|→)?\s*\)/);
      expect(guarded.summary).toContain('1) DEN -10.5 (R43)');
    }
  });

  it('P0-3 (5): get_market_movement emits (+3.6pp implied) and ClaimGrounding catches/rewrites fabricated "11% shift"', async () => {
    const mlFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          game_id: 'nhl-401892770',
          home_team: 'St. Louis Blues',
          away_team: 'Edmonton Oilers',
          opening: { ml_home: -111, ml_away: 101 },
          latest: { ml_home: -126, ml_away: 105 },
          ml_home: -126,
          ml_away: 105,
          snapshots_tracked: 3,
        }),
        { status: 200 },
      ),
    );
    const mlRes = await (getMarketMovementTool as any).execute(
      { game_id: 'nhl-401892770', market_type: 'ml' },
      {
        fetchFn: mlFetch as any,
        env: { SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_ANON_KEY: 'mock' },
      },
    );
    expect(mlRes.success).toBe(true);
    expect(mlRes.summary).toContain('+3.1pp implied');
    expect(mlRes.summary).not.toContain('% imp');

    const headers = parseGameHeaders(SLATE_WF_377);
    const fabricatedProposal: any = {
      picks: [
        {
          row: 'R62',
          event_id: 'nhl-401892770',
          side: 'St. Louis Blues ML',
          reason: 'St. Louis Blues backed by positive steam (11% shift).',
        },
      ],
      summary: 'St. Louis Blues ML (R62) backed by positive steam (11% shift).',
    };

    const audit = auditCriticPremiseContradictions(fabricatedProposal, mlRes.summary, SLATE_WF_377, { headers });
    expect(audit.pass).toBe(false);
    expect(audit.flags).toContain('fabricated_steam_shift');

    sanitizeUngroundedClaims(fabricatedProposal, mlRes.summary, SLATE_WF_377, { headers });
    expect(fabricatedProposal.picks[0].reason).not.toContain('11% shift');
    expect(fabricatedProposal.picks[0].reason).toContain('+3.1pp implied');
    expect(fabricatedProposal.summary).not.toContain('11% shift');
    expect(fabricatedProposal.summary).toContain('+3.1pp implied');
  });
});
