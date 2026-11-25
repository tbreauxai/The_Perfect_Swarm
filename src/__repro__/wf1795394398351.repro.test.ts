import { describe, it, expect, vi } from 'vitest';
import {
  sanitizeUngroundedClaims,
  normalizePassIfAllLegsVetoed,
  type VetoedLegTarget
} from '../swarm/tools/claimGrounding.ts';
import { syncCompilerProseWithFinalPicks } from '../swarm/tools/compilerProseSync.ts';
import {
  ANALYST_SYSTEM_INSTRUCTION,
  RED_TEAM_ANALYST_SYSTEM_INSTRUCTION,
  MANAGER_SYSTEM_INSTRUCTION,
  UNCERTAIN_QUESTIONABLE_RULE
} from '../swarm/engine/constants.ts';
import {
  evaluateQualitativePillars,
  formatUnifiedPerGameDossier,
  type UnifiedGameDossierEntry
} from '../swarm/engine/unifiedDossier.ts';
import { getInjuryAndRosterDeltaTool } from '../swarm/tools/dueloddsRpcTools.ts';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';

describe('SPEC_SWARM_WF (wf-1795394398351): S1, S2, S3', () => {
  // -------------------------------------------------------------------------
  // S1: Whole-Sentence Veto Pruning & Preserve scorecards[] on Full-Veto Passes
  // -------------------------------------------------------------------------
  describe('S1: Whole-Sentence Veto Pruning & Preserve scorecards[] on Full-Veto Passes', () => {
    const SLATE_WF_351 = [
      'event_id=nba-401910101 | sport=nba | Boston Celtics @ Golden State Warriors | commence=2026-11-22T23:00:00Z | options: R14 Boston Celtics -8.5 (-110), R15 Golden State Warriors +8.5 (-110)',
      'event_id=nba-401910102 | sport=nba | Indiana Pacers @ New York Knicks | commence=2026-11-22T23:30:00Z | options: R11 New York Knicks -7.5 (-110), R12 Indiana Pacers +7.5 (-110)',
      'event_id=nhl-401892770 | sport=nhl | Nashville Predators @ St. Louis Blues | commence=2026-11-22T23:00:00Z | options: R62 St. Louis Blues ML (-126), R63 Nashville Predators ML (+106)',
      'event_id=nba-401910036 | sport=nba | Oklahoma City Thunder @ Miami Heat | commence=2026-11-22T23:00:00Z | options: R65 Miami Heat ML (-144), R66 Oklahoma City Thunder ML (+122)'
    ].join('\n');

    const vetoedBosNyk: VetoedLegTarget[] = [
      {
        rowId: 'R14',
        eventId: 'nba-401910101',
        teamLabel: 'Boston Celtics',
        teamAliases: ['boston celtics', 'celtics', 'boston', 'bos'],
        reason: 'Health Balance is uncertain_questionable (Boston Celtics: 3 Q), invalidating the claimed asymmetric injury edge'
      },
      {
        rowId: 'R11',
        eventId: 'nba-401910102',
        teamLabel: 'New York Knicks',
        teamAliases: ['new york knicks', 'knicks', 'new york', 'nyk'],
        reason: 'Health Balance is uncertain_questionable (New York Knicks: 3 Q), invalidating the claimed asymmetric injury edge'
      }
    ];

    it('produces grammatical summary, analysis, and insights with zero dangling fragments and preserves non-empty scorecards[] with Risk Critic veto on full-veto pass', () => {
      const managerDraft: any = {
        ui_title: '2-Leg NBA Parlay',
        summary:
          'Bottom-line call: pass. Both Boston Celtics (R14) and New York Knicks (R11) had questionable stars, which invalidated the proposed asymmetric injury edge.',
        analysis:
          'The swarm evaluated four games for potential parlay inclusion. Because Boston Celtics -8.5 (R14) and New York Knicks -7.5 (R11) carried 3 Q designations, the Risk Critic has vetoed both selections.',
        picks: [
          { row: 'R14', side: 'Boston Celtics -8.5', reason: 'Claimed asymmetric injury edge.' },
          { row: 'R11', side: 'New York Knicks -7.5', reason: 'Claimed asymmetric injury edge.' }
        ],
        insights: [
          'Because Boston Celtics (R14) and New York Knicks (R11) carry 3 Q designations, the Risk Critic has vetoed both selections.'
        ],
        scorecards: [
          { seat: 'Quant Proposer', verdict: 'propose', picksCount: 2, notes: 'Proposed R14 and R11.' },
          {
            seat: 'Risk Critic',
            verdict: 'veto',
            criticApproved: false,
            wageringPass: true,
            notes: 'Vetoed Boston Celtics (R14) and New York Knicks (R11) due to uncertain_questionable status.'
          }
        ],
        components: [
          {
            id: 'default-insight-list',
            type: 'InsightList',
            props: {
              title: 'Synthesis Findings',
              insights: [
                {
                  type: 'warning',
                  message:
                    'Because Boston Celtics (R14) and New York Knicks (R11) carry 3 Q designations, the Risk Critic has vetoed both selections.'
                }
              ]
            }
          }
        ]
      };

      const initialPicks = [...managerDraft.picks];
      const headers = parseGameHeaders(SLATE_WF_351);

      sanitizeUngroundedClaims(managerDraft, '', SLATE_WF_351, {
        headers,
        vetoedLegs: vetoedBosNyk,
        vetoTexts: [
          'Health Balance is uncertain_questionable on Boston Celtics (3 Q) and New York Knicks (3 Q), invalidating the proposed asymmetric injury edge.'
        ]
      });

      normalizePassIfAllLegsVetoed(managerDraft, initialPicks.length, true, {
        vetoedLegs: vetoedBosNyk,
        vetoTexts: [
          'Health Balance is uncertain_questionable on Boston Celtics (3 Q) and New York Knicks (3 Q), invalidating the proposed asymmetric injury edge.'
        ],
        criticApproved: false
      });

      syncCompilerProseWithFinalPicks(managerDraft, {
        initialPicks,
        headers,
        slateText: SLATE_WF_351,
        vetoedLegs: vetoedBosNyk,
        vetoTexts: [
          'Health Balance is uncertain_questionable on Boston Celtics (3 Q) and New York Knicks (3 Q), invalidating the proposed asymmetric injury edge.'
        ],
        criticApproved: false
      });

      expect(managerDraft.picks).toEqual([]);
      expect(managerDraft.pass).toBe(true);
      expect(managerDraft.criticApproved).toBe(false);
      expect(managerDraft.wageringPass).toBe(true);

      // Zero dangling fragments or lowercase sentence starts
      expect(managerDraft.summary).toMatch(/^Bottom-line call: pass\./);
      expect(managerDraft.summary).not.toMatch(/pass\.\s+[a-z]/);
      expect(managerDraft.summary).not.toMatch(/\bpass\.\s*which\b/i);
      expect(managerDraft.summary).toMatch(/[.!?]$/);

      expect(managerDraft.analysis).not.toMatch(/\.\s+[a-z]/);
      expect(managerDraft.analysis).toMatch(/^[A-Z]/);
      expect(managerDraft.analysis).toMatch(/[.!?]$/);

      expect(Array.isArray(managerDraft.insights)).toBe(true);
      expect(managerDraft.insights.length).toBeGreaterThan(0);
      for (const ins of managerDraft.insights) {
        expect(ins).toMatch(/^[A-Z]/);
        expect(ins).toMatch(/[.!?]$/);
      }

      // Preserve scorecards[] with Risk Critic veto entry
      expect(Array.isArray(managerDraft.scorecards)).toBe(true);
      expect(managerDraft.scorecards.length).toBeGreaterThanOrEqual(2);
      const criticCard = managerDraft.scorecards.find((s: any) => s.seat === 'Risk Critic');
      expect(criticCard).toBeDefined();
      expect(criticCard).toMatchObject({
        seat: 'Risk Critic',
        verdict: 'veto',
        criticApproved: false,
        wageringPass: true
      });
    });

    it('partial-veto cleanup (1 of 3 legs vetoed) deletes only complete sentences referencing the vetoed leg while keeping surviving legs intact', () => {
      const headers = parseGameHeaders(SLATE_WF_351);
      const partialPayload: any = {
        ui_title: '3-Leg Multi-Sport Parlay',
        summary:
          'Play St. Louis Blues ML (R62) and Miami Heat ML (R65) as the core card. Back Boston Celtics -8.5 (R14) for an injury edge, which rounds out the third leg.',
        analysis:
          'St. Louis Blues ML (R62) is backed by strong home form and favorable ML steam. Back Boston Celtics -8.5 (R14) on an assumed injury edge, which adds NBA spread exposure. Miami Heat ML (R65) carries steady home market support.',
        picks: [
          { row: 'R62', side: 'St. Louis Blues ML', reason: 'Strong home form and ML steam.' },
          { row: 'R65', side: 'Miami Heat ML', reason: 'Steady home market support.' }
        ],
        insights: [
          '[R62] St. Louis Blues ML — Strong home form and ML steam.',
          '[R14] Boston Celtics -8.5 — Assumed injury edge, which adds spread exposure.',
          '[R65] Miami Heat ML — Steady home market support.'
        ]
      };

      const res = syncCompilerProseWithFinalPicks(partialPayload, {
        initialPicks: [
          { row: 'R62', side: 'St. Louis Blues ML' },
          { row: 'R14', side: 'Boston Celtics -8.5' },
          { row: 'R65', side: 'Miami Heat ML' }
        ],
        headers,
        slateText: SLATE_WF_351,
        vetoedLegs: [vetoedBosNyk[0]]
      });

      expect(res.synced).toBe(true);
      expect(partialPayload.summary).toBe('Play St. Louis Blues ML (R62) and Miami Heat ML (R65) as the core card.');
      expect(partialPayload.summary).not.toContain('Celtics');
      expect(partialPayload.summary).not.toContain('which rounds out');

      expect(partialPayload.analysis).toBe(
        'St. Louis Blues ML (R62) is backed by strong home form and favorable ML steam. Miami Heat ML (R65) carries steady home market support.'
      );
      expect(partialPayload.analysis).not.toContain('Celtics');
      expect(partialPayload.analysis).not.toContain('which adds');

      expect(partialPayload.insights).toHaveLength(2);
      expect(partialPayload.insights.join(' ')).toContain('R62');
      expect(partialPayload.insights.join(' ')).toContain('R65');
      expect(partialPayload.insights.join(' ')).not.toContain('R14');
    });
  });

  // -------------------------------------------------------------------------
  // S2: Explicit uncertain_questionable Prohibition for Proposers & Pillar 3
  // -------------------------------------------------------------------------
  describe('S2: Explicit uncertain_questionable Prohibition & Pillar 3 Scoring', () => {
    it('includes the explicit uncertain_questionable Pillar 3 prohibition in proposer and manager instructions', () => {
      expect(ANALYST_SYSTEM_INSTRUCTION).toContain(UNCERTAIN_QUESTIONABLE_RULE);
      expect(RED_TEAM_ANALYST_SYSTEM_INSTRUCTION).toContain(UNCERTAIN_QUESTIONABLE_RULE);
      expect(MANAGER_SYSTEM_INSTRUCTION).toContain(UNCERTAIN_QUESTIONABLE_RULE);
      expect(ANALYST_SYSTEM_INSTRUCTION).toMatch(/uncertain_questionable/i);
      expect(ANALYST_SYSTEM_INSTRUCTION).toMatch(/disqualifying for Pillar 3/i);
    });

    it('awards 0 health-pillar credit to uncertain_questionable matchups (BOS @ GSW, IND @ NYK, MIN @ SF) while crediting true away_advantage', () => {
      const entries: UnifiedGameDossierEntry[] = [
        {
          eventId: 'nba-bos-gsw',
          matchup: 'Boston Celtics @ Golden State Warriors',
          sport: 'basketball_nba',
          fundamentals: 'Away (BOS): Net Margin +4.0 | Home (GSW): Net Margin +2.5',
          injuries:
            'Summary: Golden State Warriors (4 OUT, 0 Q) vs Boston Celtics (1 OUT, 3 Q) | Health Balance: uncertain_questionable (Boston Celtics: 3 Q)',
          market: 'Steam: neutral',
          hasDirectionalSteam: false,
          outCountDiff: 3,
          netMarginGap: 1.5
        },
        {
          eventId: 'nba-ind-nyk',
          matchup: 'Indiana Pacers @ New York Knicks',
          sport: 'basketball_nba',
          fundamentals: 'Away (IND): Net Margin +1.0 | Home (NYK): Net Margin +2.0',
          injuries:
            'Summary: New York Knicks (1 OUT, 3 Q) vs Indiana Pacers (4 OUT, 0 Q) | Health Balance: uncertain_questionable (New York Knicks: 3 Q)',
          market: 'Steam: neutral',
          hasDirectionalSteam: false,
          outCountDiff: 3,
          netMarginGap: 1.0
        },
        {
          eventId: 'nfl-min-sf',
          matchup: 'Minnesota Vikings @ San Francisco 49ers',
          sport: 'americanfootball_nfl',
          fundamentals: 'Away (MIN): Net Margin +0.5 | Home (SF): Net Margin +1.2',
          injuries:
            'Summary: San Francisco 49ers (2 OUT, 4 Q) vs Minnesota Vikings (5 OUT, 1 Q) | Health Balance: uncertain_questionable (San Francisco 49ers: 4 Q)',
          market: 'Steam: neutral',
          hasDirectionalSteam: false,
          outCountDiff: 3,
          netMarginGap: 0.7
        },
        {
          eventId: 'nba-dal-uta',
          matchup: 'Dallas Mavericks @ Utah Jazz',
          sport: 'basketball_nba',
          fundamentals: 'Away (DAL): Net Margin +5.2 | Home (UTA): Net Margin -4.1',
          injuries:
            'Summary: Utah Jazz (3 OUT [impact 9.0], 0 Q) vs Dallas Mavericks (5 OUT [impact 4.5], 0 Q) | Health Balance: away_advantage (Dallas Mavericks, +4.5 impact edge)',
          market: 'Steam: TOWARD away Dallas Mavericks (-5.5 -> -6.5, 1.0 pt)',
          hasDirectionalSteam: true,
          outCountDiff: 4.5,
          netMarginGap: 9.3
        }
      ];

      for (const uncertainEntry of entries.slice(0, 3)) {
        const ev = evaluateQualitativePillars(uncertainEntry);
        expect(ev.tags.some((t) => t.startsWith('health='))).toBe(false);
        expect(ev.pillarCount).toBe(0);
        expect(ev.outCountDiff).toBe(0);
      }

      const cleanEval = evaluateQualitativePillars(entries[3]);
      expect(cleanEval.tags).toContain('health=away_advantage');
      expect(cleanEval.pillarCount).toBe(3);

      const formatted = formatUnifiedPerGameDossier(entries);
      expect(formatted.text).toContain('=== TOP PILLAR CANDIDATES (QUALITATIVE) ===');
      const headerBlock = formatted.text.split('=== GAME DOSSIER:')[0];
      expect(headerBlock).toContain('nba-dal-uta');
      expect(headerBlock).not.toContain('nba-bos-gsw');
      expect(headerBlock).not.toContain('nba-ind-nyk');
      expect(headerBlock).not.toContain('nfl-min-sf');
    });
  });

  // -------------------------------------------------------------------------
  // S3: Starter-Weighted Injury Impact Summary + Honest [unweighted_fallback] Tag
  // -------------------------------------------------------------------------
  describe('S3: Starter-Weighted Injury Impact Summary + Honest [unweighted_fallback] Tag', () => {
    it('populated logs (ESPN numeric player_id + stats JSONB): Utah 3 Tier-1 (9.0) vs Dallas 2 Tier-2 + 3 Tier-3 (4.5) prints [impact 9.0] / [impact 4.5] and away_advantage (+4.5 impact edge)', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('player_game_logs')) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              { player_id: '4066336', sport: 'basketball_nba', team_abbr: 'UTA', stats: { position: 'PF', minutes: 33.4, points: 23.1 } },
              { player_id: '4277811', sport: 'basketball_nba', team_abbr: 'UTA', stats: { position: 'SG', minutes: 29.8, points: 18.2 } },
              { player_id: '3908845', sport: 'basketball_nba', team_abbr: 'UTA', stats: { position: 'PF', minutes: 30.1, points: 16.8 } },
              { player_id: '5105565', sport: 'basketball_nba', team_abbr: 'DAL', stats: { position: 'G', minutes: 19.0, points: 9.2 } },
              { player_id: '5105566', sport: 'basketball_nba', team_abbr: 'DAL', stats: { position: 'F', minutes: 17.5, points: 8.5 } }
              // 3 Dallas depth players are unlogged on a team that DOES have game-log coverage -> Tier 3 (0.5 each)
            ]
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            event_id: 'nba-401910099',
            sport: 'basketball_nba',
            home_team: 'Utah Jazz',
            away_team: 'Dallas Mavericks',
            injuries: [
              { player_id: '4066336', player_name: 'Lauri Markkanen', team: 'Utah Jazz', position: 'PF', status: 'OUT' },
              { player_id: '4277811', player_name: 'Collin Sexton', team: 'Utah Jazz', position: 'SG', status: 'OUT' },
              { player_id: '3908845', player_name: 'John Collins', team: 'Utah Jazz', position: 'PF', status: 'OUT' },
              { player_id: '5105565', player_name: 'Rotation Guard A', team: 'Dallas Mavericks', position: 'G', status: 'OUT' },
              { player_id: '5105566', player_name: 'Rotation Wing B', team: 'Dallas Mavericks', position: 'F', status: 'OUT' },
              { player_id: '9000001', player_name: 'Depth One', team: 'Dallas Mavericks', position: 'F', status: 'OUT' },
              { player_id: '9000002', player_name: 'Depth Two', team: 'Dallas Mavericks', position: 'C', status: 'OUT' },
              { player_id: '9000003', player_name: 'Depth Three', team: 'Dallas Mavericks', position: 'G', status: 'OUT' }
            ]
          })
        };
      });

      const res = await getInjuryAndRosterDeltaTool.execute(
        { game_id: 'nba-401910099' },
        {
          env: {
            SUPABASE_URL: 'https://test.supabase.co',
            SUPABASE_ANON_KEY: 'anon-key',
            SUPABASE_SERVICE_ROLE_KEY: 'service-key'
          },
          fetchFn: mockFetch as any
        }
      );

      expect(res.success).toBe(true);
      expect(res.summary).toContain('[impact 9.0');
      expect(res.summary).toContain('[impact 4.5');
      expect(res.summary).toContain('Health Balance: away_advantage (Dallas Mavericks, +4.5 impact edge)');
      expect(res.summary).not.toContain('[unweighted_fallback]');
    });

    it('Tier-1 Q guard: single QUESTIONABLE NFL QB1 or NHL starting goalie forces uncertain_questionable via stats JSONB (pass_attempts / goalie_starts)', async () => {
      const nflFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('player_game_logs')) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              { player_id: '3917315', sport: 'americanfootball_nfl', team_abbr: 'ARI', stats: { position: 'QB', pass_attempts: 34 } },
              { player_id: '3917999', sport: 'americanfootball_nfl', team_abbr: 'ARI', stats: { position: 'QB', pass_attempts: 2 } }
            ]
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            event_id: 'nfl-401873111',
            sport: 'americanfootball_nfl',
            home_team: 'Arizona Cardinals',
            away_team: 'Seattle Seahawks',
            injuries: [
              { player_id: '3917315', player_name: 'Kyler Murray', team: 'Arizona Cardinals', position: 'QB', status: 'QUESTIONABLE' }
            ]
          })
        };
      });

      const nflRes = await getInjuryAndRosterDeltaTool.execute(
        { game_id: 'nfl-401873111' },
        {
          env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'service-key' },
          fetchFn: nflFetch as any
        }
      );
      expect(nflRes.success).toBe(true);
      expect(nflRes.summary).toContain('Health Balance: uncertain_questionable (Arizona Cardinals: Tier-1 Q Kyler Murray)');

      const nhlFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('player_game_logs')) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              { player_id: '3114727', sport: 'icehockey_nhl', team_abbr: 'VAN', stats: { position: 'G', goalie_starts: 5, toi: 60 } },
              { player_id: '3114799', sport: 'icehockey_nhl', team_abbr: 'VAN', stats: { position: 'G', goalie_starts: 1, toi: 58 } }
            ]
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            event_id: 'nhl-401892888',
            sport: 'icehockey_nhl',
            home_team: 'Vancouver Canucks',
            away_team: 'Edmonton Oilers',
            injuries: [
              { player_id: '3114727', player_name: 'Thatcher Demko', team: 'Vancouver Canucks', position: 'G', status: 'QUESTIONABLE' }
            ]
          })
        };
      });

      const nhlRes = await getInjuryAndRosterDeltaTool.execute(
        { game_id: 'nhl-401892888' },
        {
          env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'service-key' },
          fetchFn: nhlFetch as any
        }
      );
      expect(nhlRes.success).toBe(true);
      expect(nhlRes.summary).toContain('Health Balance: uncertain_questionable (Vancouver Canucks: Tier-1 Q Thatcher Demko)');
    });

    it('empty logs (0 rows from player_game_logs): sets impact_tier: null and appends [unweighted_fallback] to Health Balance', async () => {
      const emptyLogsFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('player_game_logs')) {
          return {
            ok: true,
            status: 200,
            json: async () => []
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            event_id: 'nfl-401873222',
            sport: 'americanfootball_nfl',
            home_team: 'Tampa Bay Buccaneers',
            away_team: 'Arizona Cardinals',
            injuries: [
              { player_id: '3917315', player_name: 'Kyler Murray', team: 'Arizona Cardinals', position: 'QB', status: 'OUT' },
              { player_id: '16737', player_name: 'Mike Evans', team: 'Tampa Bay Buccaneers', position: 'WR', status: 'OUT' },
              { player_id: '4567890', player_name: 'Bo Richter', team: 'Arizona Cardinals', position: 'LB', status: 'OUT' },
              { player_id: '4567891', player_name: 'Reserve Tackle', team: 'Arizona Cardinals', position: 'OT', status: 'OUT' }
            ]
          })
        };
      });

      const res = await getInjuryAndRosterDeltaTool.execute(
        { game_id: 'nfl-401873222' },
        {
          env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'service-key' },
          fetchFn: emptyLogsFetch as any
        }
      );

      expect(res.success).toBe(true);
      expect(res.summary).toContain('Health Balance: home_advantage (Tampa Bay Buccaneers) [unweighted_fallback]');
      const injuries = (res.data as any)?.injuries || [];
      expect(injuries.length).toBe(4);
      for (const inj of injuries) {
        expect(inj.impact_tier).toBeNull();
      }
    });
  });
});
