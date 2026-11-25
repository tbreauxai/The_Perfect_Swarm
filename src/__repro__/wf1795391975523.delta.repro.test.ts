import { describe, it, expect, vi } from 'vitest';
import {
  auditClaimGrounding,
  detectIntraSeatDuplicateLegs
} from '../swarm/tools/claimGrounding.ts';
import {
  getMarketMovementTool,
  getInjuryAndRosterDeltaTool,
  isIndoorLeagueGame
} from '../swarm/tools/dueloddsRpcTools.ts';
import {
  fetchTwoHopSlateDossier,
  HOP1_TOOL_EXECUTION_TIMEOUT_MS
} from '../swarm/engine/unifiedDossier.ts';
import {
  stripApproximateOdds,
  sanitizeMoneylinePriceMoves,
  guardAnalystResponse
} from '../swarm/parser/responseGuards.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { SwarmContext } from '../swarm/context.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { GameQueryCache } from '../swarm/cache/gameQueryCache.ts';
import type { GameHeader } from '../swarm/context/gameHeaders.ts';

describe('wf-1795391975523 Delta Fix Spec (P0-1 through P1-2)', () => {
  // -------------------------------------------------------------------------
  // P0-1: Deterministic Grounding Verifier Corpus
  // -------------------------------------------------------------------------
  describe('P0-1: Deterministic Grounding Verifier Corpus (curatedDossier authoritative)', () => {
    it('passes "Denver Nuggets hold a 6-2 away record" when curatedDossier has Season 11-6 (6-2 Away, Diff +1.2) even if raw slate says 4-2 Away', () => {
      const rawSlateWithStaleStandings = [
        'event_id=nba-401910032 | sport=nba | Denver Nuggets @ Chicago Bulls | commence=2026-11-22T01:00:00Z | options: R20 Denver Nuggets -9.5 (-110), R21 Chicago Bulls +9.5 (-110)',
        'Standings: Denver Nuggets (9-6, 4-2 Away) vs Chicago Bulls (7-9, 4-4 Home)'
      ].join('\n');

      const curatedDossier = {
        sections: [
          {
            tool: 'get_matchup_fundamentals',
            event_id: 'nba-401910032',
            summary:
              '[MATCHUP FUNDAMENTALS: nba-401910032] Away (Denver Nuggets): Season 11-6 (6-2 Away, Diff +1.2) | Home (Chicago Bulls): Season 7-10 (4-5 Home, Diff -3.8)'
          }
        ]
      };

      const proposal = {
        picks: [{ row: 'R20', side: 'Denver Nuggets -9.5', reason: 'Denver Nuggets hold a 6-2 away record.' }],
        analysis: 'Denver Nuggets hold a 6-2 away record and a positive net margin (+1.2) entering Chicago.'
      };

      const audit = auditClaimGrounding(proposal, '', rawSlateWithStaleStandings, {
        curatedDossier
      });

      expect(audit.violations).toEqual([]);
      expect(audit.pass).toBe(true);
      expect(audit.flags).not.toContain('ungrounded_form_claim');
    });

    it('still fails when citing a fabricated away record not in curatedDossier or COMPACT SLATE', () => {
      const rawSlate = [
        'EVENT nba-401910032 | NBA | Denver Nuggets @ Chicago Bulls | 2026-11-22T01:00:00Z',
        'R20: Denver Nuggets -9.5 (-110)'
      ].join('\n');

      const curatedDossier = {
        sections: [
          {
            tool: 'get_matchup_fundamentals',
            event_id: 'nba-401910032',
            summary:
              '[MATCHUP FUNDAMENTALS: nba-401910032] Away (Denver Nuggets): Season 11-6 (6-2 Away, Diff +1.2)'
          }
        ]
      };

      const proposal = {
        picks: [{ row: 'R20', side: 'Denver Nuggets -9.5' }],
        analysis: 'Denver Nuggets hold a 14-1 away record this season.'
      };

      const audit = auditClaimGrounding(proposal, '', rawSlate, { curatedDossier });
      expect(audit.pass).toBe(false);
      expect(audit.flags).toContain('ungrounded_form_claim');
    });
  });

  // -------------------------------------------------------------------------
  // P0-2: Deterministic Veto-Leakage Override & Pre-Verification Post-Prune Sync
  // -------------------------------------------------------------------------
  describe('P0-2: Veto-Leakage Override & Pre-Verification Post-Prune Sync', () => {
    const slate = [
      'event_id=nhl-401892770 | sport=nhl | Nashville Predators @ St. Louis Blues | commence=2026-11-22T01:00:00Z | options: R39 St. Louis Blues ML (-126), R40 Nashville Predators ML (+106)',
      'event_id=nba-401910032 | sport=nba | Denver Nuggets @ Chicago Bulls | commence=2026-11-22T01:00:00Z | options: R20 Denver Nuggets -9.5 (-110), R21 Chicago Bulls +9.5 (-110)'
    ].join('\n');

    const evidence = [
      '[MARKET MOVEMENT: nhl-401892770 | all] Current: home St. Louis Blues ML -126 / away Nashville Predators ML +106 | Steam: TOWARD home St. Louis Blues ML (-111 -> -126, +3.6pp implied) | AGAINST away Nashville Predators ML (-109 -> +106)',
      '[MATCHUP FUNDAMENTALS: nhl-401892770] Home (St. Louis Blues): W-L 4-1'
    ].join('\n');

    const vetoedNuggets = [
      {
        rowId: 'R20',
        eventId: 'nba-401910032',
        teamLabel: 'Denver Nuggets',
        teamAliases: ['denver nuggets', 'nuggets', 'denver', 'den'],
        reason: 'Vetoed by Risk Critic'
      }
    ];

    it('passes deterministic verification on Attempt 1 when R39 is in picks/Selected Wagers and Denver Nuggets -9.5 is only in a rejection clause', async () => {
      const proposerProposal = {
        ui_title: 'NHL Single Play',
        summary: 'Proceed with St. Louis Blues ML (R39).',
        analysis: 'Proceed with St. Louis Blues ML (R39). Denver Nuggets -9.5 was vetoed by the Risk Critic and excluded from the card.',
        picks: [{ row: 'R39', side: 'St. Louis Blues ML', reason: 'Favorable ML steam toward St. Louis Blues.' }],
        components: [
          {
            type: 'DataTable',
            props: {
              title: 'Selected Wagers',
              headers: ['Row', 'Pick'],
              rows: [{ Row: 'R39', Pick: 'St. Louis Blues ML' }]
            }
          },
          {
            type: 'InsightList',
            props: {
              title: 'Key Insights',
              insights: [{ type: 'info', message: 'St. Louis Blues ML (R39) backed by favorable ML steam.' }]
            }
          }
        ]
      };

      // Direct grounding audit check
      const directAudit = auditClaimGrounding(proposerProposal, evidence, slate, {
        vetoedLegs: vetoedNuggets
      });
      expect(directAudit.pass).toBe(true);
      expect(directAudit.flags).not.toContain('vetoed_leg_recommended');
      expect(directAudit.flags).not.toContain('vetoed_leg_kept');

      // Full AnalysisLifecycle Attempt 1 check (must NOT drop to RLAIF 35%)
      const mockProposer: any = {
        role: 'Manager',
        provider: 'gemini',
        modelName: 'mock-manager',
        run: vi.fn().mockResolvedValue(JSON.stringify(proposerProposal))
      };
      const mockCritic: any = {
        role: 'Critic',
        provider: 'gemini',
        modelName: 'mock-critic',
        run: vi.fn().mockResolvedValue(JSON.stringify({ pass: true, feedback: 'R39 St. Louis Blues ML verified cleanly.' }))
      };

      const lifecycle = new AnalysisLifecycle(mockProposer, mockCritic, 2);
      const ctx = new SwarmContext();
      const res = await lifecycle.executeAndVerify(
        { fullBoard: slate, toolResults: evidence, vetoedLegs: vetoedNuggets },
        ctx,
        'Build tonight card',
        'Verify proposed picks'
      );

      expect(res.success).toBe(true);
      expect(res.attempts).toBe(1);
      expect(res.computedRating).toBeGreaterThan(0.5);
      expect(res.finalProposal?.picks).toHaveLength(1);
      expect(res.finalProposal?.picks[0].row).toBe('R39');
    });

    it('still fails verification when the vetoed team remains inside picks[] or Selected Wagers', () => {
      const keptInPicks = {
        analysis: 'Play St. Louis Blues ML (R39) and Denver Nuggets -9.5 (R20).',
        picks: [
          { row: 'R39', side: 'St. Louis Blues ML' },
          { row: 'R20', side: 'Denver Nuggets -9.5' }
        ]
      };
      const picksAudit = auditClaimGrounding(keptInPicks, evidence, slate, {
        vetoedLegs: vetoedNuggets
      });
      expect(picksAudit.pass).toBe(false);
      expect(picksAudit.flags).toContain('vetoed_leg_kept');

      const keptInSelectedWagers = {
        analysis: 'Proceed with St. Louis Blues ML (R39).',
        picks: [{ row: 'R39', side: 'St. Louis Blues ML' }],
        components: [
          {
            type: 'DataTable',
            props: {
              title: 'Selected Wagers',
              headers: ['Row', 'Pick'],
              rows: [
                { Row: 'R39', Pick: 'St. Louis Blues ML' },
                { Row: 'R20', Pick: 'Denver Nuggets -9.5' }
              ]
            }
          }
        ]
      };
      const tableAudit = auditClaimGrounding(keptInSelectedWagers, evidence, slate, {
        vetoedLegs: vetoedNuggets
      });
      expect(tableAudit.pass).toBe(false);
      expect(tableAudit.flags).toContain('vetoed_leg_kept');
    });
  });

  // -------------------------------------------------------------------------
  // P0-3: Independent Side Steam and Total Steam in get_market_movement
  // -------------------------------------------------------------------------
  describe('P0-3: Independent Side Steam and Total Steam in get_market_movement', () => {
    it('emits both TOWARD away Denver Nuggets and TOWARD Under for nba-401910032 (spread -8.5 -> -9.5, total 237.5 -> 236.5)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          event_id: 'nba-401910032',
          sport: 'basketball_nba',
          home_team: 'Chicago Bulls',
          away_team: 'Denver Nuggets',
          book: 'fanduel',
          books_tracked: 1,
          snapshots_tracked: 2,
          line_snapshots: [
            {
              book: 'fanduel',
              captured_at: '2026-11-22T12:00:00Z',
              spread_home: 8.5,
              spread_away: -8.5,
              total: 237.5,
              ml_home: 290,
              ml_away: -360
            },
            {
              book: 'fanduel',
              captured_at: '2026-11-22T18:00:00Z',
              spread_home: 9.5,
              spread_away: -9.5,
              total: 236.5,
              ml_home: 320,
              ml_away: -405
            }
          ]
        })
      });

      const res = await getMarketMovementTool.execute(
        { game_id: 'nba-401910032', market_type: 'all' },
        {
          env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'anon-key' },
          fetchFn: mockFetch as any
        }
      );

      expect(res.success).toBe(true);
      expect(res.summary).toContain('TOWARD away Denver Nuggets (-8.5 -> -9.5, 1.0 pt)');
      expect(res.summary).toContain('AGAINST home Chicago Bulls (+8.5 -> +9.5)');
      expect(res.summary).toContain('Total TOWARD Under (237.5 -> 236.5, -1.0 pts)');
      expect(res.summary).toContain('Divergence: single_book');
      expect(res.summary).not.toContain('[extended_move: verify remaining value]');
    });

    it('preserves [extended_move: verify remaining value] when spread moves >= 2.0 pts alongside a total move', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          event_id: 'nba-401910032',
          sport: 'basketball_nba',
          home_team: 'Chicago Bulls',
          away_team: 'Denver Nuggets',
          book: 'fanduel',
          books_tracked: 1,
          snapshots_tracked: 2,
          line_snapshots: [
            {
              book: 'fanduel',
              captured_at: '2026-11-22T12:00:00Z',
              spread_home: 8.5,
              spread_away: -8.5,
              total: 237.5
            },
            {
              book: 'fanduel',
              captured_at: '2026-11-22T18:00:00Z',
              spread_home: 10.5,
              spread_away: -10.5,
              total: 236.5
            }
          ]
        })
      });

      const res = await getMarketMovementTool.execute(
        { game_id: 'nba-401910032', market_type: 'all' },
        {
          env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'anon-key' },
          fetchFn: mockFetch as any
        }
      );

      expect(res.success).toBe(true);
      expect(res.summary).toContain('TOWARD away Denver Nuggets (-8.5 -> -10.5, 2.0 pts)');
      expect(res.summary).toContain('Total TOWARD Under (237.5 -> 236.5, -1.0 pts)');
      expect(res.summary).toContain('[extended_move: verify remaining value]');
    });
  });

  // -------------------------------------------------------------------------
  // P0-4: Scope duplicate_leg Strictly Within a Single Seat's Parlay
  // -------------------------------------------------------------------------
  describe('P0-4: Scope duplicate_leg strictly within a single seat', () => {
    const slate = [
      'EVENT nhl-401892770 | NHL | Nashville Predators @ St. Louis Blues | 2026-11-22T01:00:00Z',
      'R39: St. Louis Blues ML (-126) | R8: St. Louis Blues -1.5 (+185)',
      'EVENT nba-401910032 | NBA | Denver Nuggets @ Chicago Bulls | 2026-11-22T01:00:00Z',
      'R20: Denver Nuggets -9.5 (-110)'
    ].join('\n');

    it('produces zero duplicate_leg flag when a1 proposes [R39, R20] and a2 proposes [R39] (consensus)', () => {
      const res = detectIntraSeatDuplicateLegs(
        {
          seatReports: [
            {
              seat: 'a1',
              picks: [
                { row: 'R39', side: 'St. Louis Blues ML' },
                { row: 'R20', side: 'Denver Nuggets -9.5' }
              ]
            },
            {
              seat: 'a2',
              picks: [{ row: 'R39', side: 'St. Louis Blues ML' }]
            }
          ]
        },
        [],
        slate
      );

      expect(res.pass).toBe(true);
      expect(res.flags).toEqual([]);
      expect(res.violations).toEqual([]);
    });

    it('produces duplicate_leg when a single seat proposes [R39, R8] on nhl-401892770', () => {
      const res = detectIntraSeatDuplicateLegs(
        {
          seatReports: [
            {
              seat: 'a1',
              picks: [
                { row: 'R39', side: 'St. Louis Blues ML' },
                { row: 'R8', side: 'St. Louis Blues -1.5' }
              ]
            }
          ]
        },
        [],
        slate
      );

      expect(res.pass).toBe(false);
      expect(res.flags).toContain('duplicate_leg');
      expect(res.violations).toHaveLength(1);
      expect(res.violations[0].eventId).toBe('nhl-401892770');
    });
  });

  // -------------------------------------------------------------------------
  // P0-5: Hop-1 4000ms Timeout, Concurrency Pool <= 8, Single Retry on Timeout
  // -------------------------------------------------------------------------
  describe('P0-5: Hop-1 Timeout (4000ms), Concurrency <= 8, and Single Retry on Timeout', () => {
    it('exports 4000ms default timeout, caps concurrency <= 8, and retries a single transient timeout once', async () => {
      expect(HOP1_TOOL_EXECUTION_TIMEOUT_MS).toBe(4000);

      let inFlight = 0;
      let peakInFlight = 0;
      const callCounts = new Map<string, number>();

      const makeTool = (name: string) => ({
        name,
        description: `Mock ${name}`,
        parameters: { game_id: { type: 'string' as const, description: 'Game ID', required: true } },
        execute: async (args: Record<string, any>) => {
          const key = `${name}:${args.game_id}`;
          const attempt = (callCounts.get(key) ?? 0) + 1;
          callCounts.set(key, attempt);

          inFlight++;
          peakInFlight = Math.max(peakInFlight, inFlight);
          try {
            // Simulate a single transient timeout on game-0 get_matchup_fundamentals attempt 1
            if (name === 'get_matchup_fundamentals' && args.game_id === 'nba-0' && attempt === 1) {
              await new Promise((r) => setTimeout(r, 120));
              return { success: true, summary: 'late' };
            }
            await new Promise((r) => setTimeout(r, 15));
            return {
              success: true,
              summary: `[${name}: ${args.game_id}] ok attempt=${attempt}`
            };
          } finally {
            inFlight--;
          }
        }
      });

      const registry = new ToolRegistry();
      registry.register(makeTool('get_matchup_fundamentals'));
      registry.register(makeTool('get_injury_and_roster_delta'));
      registry.register(makeTool('get_market_movement'));

      const headers: GameHeader[] = Array.from({ length: 5 }, (_, i) => ({
        eventId: `nba-${i}`,
        sport: 'NBA',
        away: `Away${i}`,
        home: `Home${i}`,
        options: []
      }));

      const dossier = await fetchTwoHopSlateDossier(
        headers,
        registry,
        new GameQueryCache(),
        undefined,
        { timeoutMs: 60, maxConcurrency: 12 } // Even if caller passes 12, must cap <= 8
      );

      expect(peakInFlight).toBeLessThanOrEqual(8);
      // nba-0 fundamentals timed out on attempt 1 (120ms > 60ms) and succeeded on retry attempt 2
      expect(callCounts.get('get_matchup_fundamentals:nba-0')).toBe(2);
      const retrySection = dossier.sections.find(
        (s) => s.tool === 'get_matchup_fundamentals' && s.event_id === 'nba-0'
      );
      expect(retrySection?.status).toBe('ok');
      expect(retrySection?.summary).toContain('attempt=2');
    });
  });

  // -------------------------------------------------------------------------
  // P1-1: Starter-Weighted Injury Impact in Summary: & Health Balance
  // -------------------------------------------------------------------------
  describe('P1-1: Starter-Weighted Injury Impact Into Summary: & Health Balance', () => {
    it('prints [impact 9.0] / [impact 4.5] and classifies away_advantage (Dallas Mavericks) when Utah misses 3 Tier-1 vs Dallas missing 2 Tier-2 + 3 Tier-3', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('player_game_logs')) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              { player_name: 'Lauri Markkanen', team_abbr: 'UTA', position: 'PF', minutes: 33.4, points: 23.1 },
              { player_name: 'Collin Sexton', team_abbr: 'UTA', position: 'SG', minutes: 29.8, points: 18.2 },
              { player_name: 'John Collins', team_abbr: 'UTA', position: 'PF', minutes: 30.1, points: 16.8 },
              { player_name: 'Rotation Guard A', team_abbr: 'DAL', position: 'G', minutes: 19.0, points: 9.2 },
              { player_name: 'Rotation Wing B', team_abbr: 'DAL', position: 'F', minutes: 17.5, points: 8.5 },
              { player_name: 'Depth One', team_abbr: 'DAL', position: 'F', minutes: 6.0, points: 1.8 },
              { player_name: 'Depth Two', team_abbr: 'DAL', position: 'C', minutes: 5.0, points: 1.2 },
              { player_name: 'Depth Three', team_abbr: 'DAL', position: 'G', minutes: 4.5, points: 0.9 }
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
              { player_name: 'Lauri Markkanen', team: 'Utah Jazz', position: 'PF', status: 'OUT' },
              { player_name: 'Collin Sexton', team: 'Utah Jazz', position: 'SG', status: 'OUT' },
              { player_name: 'John Collins', team: 'Utah Jazz', position: 'PF', status: 'OUT' },
              { player_name: 'Rotation Guard A', team: 'Dallas Mavericks', position: 'G', status: 'OUT' },
              { player_name: 'Rotation Wing B', team: 'Dallas Mavericks', position: 'F', status: 'OUT' },
              { player_name: 'Depth One', team: 'Dallas Mavericks', position: 'F', status: 'OUT' },
              { player_name: 'Depth Two', team: 'Dallas Mavericks', position: 'C', status: 'OUT' },
              { player_name: 'Depth Three', team: 'Dallas Mavericks', position: 'G', status: 'OUT' }
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
    });

    it('applies tier weight 1.5 when explicit impact_tier: 2 is present even without logs, and forces uncertain_questionable on a single Tier-1 QUESTIONABLE star', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          event_id: 'nba-401910100',
          sport: 'basketball_nba',
          home_team: 'Milwaukee Bucks',
          away_team: 'Boston Celtics',
          injuries: [
            { player_name: 'Giannis Antetokounmpo', team: 'Milwaukee Bucks', position: 'PF', status: 'QUESTIONABLE', impact_tier: 1 },
            { player_name: 'Bench Rotation Wing', team: 'Boston Celtics', position: 'F', status: 'OUT', impact_tier: 2 }
          ]
        })
      });

      const res = await getInjuryAndRosterDeltaTool.execute(
        { game_id: 'nba-401910100' },
        {
          env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'anon-key' },
          fetchFn: mockFetch as any
        }
      );

      expect(res.success).toBe(true);
      expect(res.summary).toContain('Health Balance: uncertain_questionable (Milwaukee Bucks: Tier-1 Q Giannis Antetokounmpo)');
      expect(res.summary).toContain('[impact 1.5');
      const benchRow = (res.data as any)?.injuries?.find((i: any) => i.player_name === 'Bench Rotation Wing');
      expect(benchRow?.impact_weight).toBe(1.5);
    });
  });

  // -------------------------------------------------------------------------
  // P1-2: Skip get_environment_and_weather for Indoor Leagues & Preserve Price-Band Text
  // -------------------------------------------------------------------------
  describe('P1-2: Indoor League Weather Skip & Policy Price-Band Preservation', () => {
    it('identifies indoor vs outdoor leagues accurately', () => {
      expect(isIndoorLeagueGame('nba-401910032')).toBe(true);
      expect(isIndoorLeagueGame('nhl-401892770')).toBe(true);
      expect(isIndoorLeagueGame('ncaab-401800111')).toBe(true);
      expect(isIndoorLeagueGame('wnba-401700222')).toBe(true);
      expect(isIndoorLeagueGame('nfl-401873077')).toBe(false);
      expect(isIndoorLeagueGame('ncaaf-401800999')).toBe(false);
      expect(isIndoorLeagueGame('mlb-401600123')).toBe(false);
    });

    it('verifier skips get_environment_and_weather for nba-401910032 and nhl-401892770, and calls it for outdoor nfl-* games', async () => {
      const weatherCalls: string[] = [];
      const registry = new ToolRegistry();
      registry.register({
        name: 'get_environment_and_weather',
        description: 'Weather',
        parameters: { game_id: { type: 'string', description: 'ID', required: true } },
        execute: async (args: Record<string, any>) => {
          weatherCalls.push(String(args.game_id));
          return { success: true, summary: `[WEATHER: ${args.game_id}] Outdoor 52F wind 11 mph` };
        }
      });
      registry.register({
        name: 'get_market_movement',
        description: 'Market',
        parameters: { game_id: { type: 'string', description: 'ID', required: true } },
        execute: async (args: Record<string, any>) => ({
          success: true,
          summary: `[MARKET MOVEMENT: ${args.game_id} | all] Steam: neutral`
        })
      });
      registry.register({
        name: 'get_injury_and_roster_delta',
        description: 'Injuries',
        parameters: { game_id: { type: 'string', description: 'ID', required: true } },
        execute: async (args: Record<string, any>) => ({
          success: true,
          summary: `[INJURY & ROSTER DELTA: ${args.game_id}] No significant injuries.`
        })
      });
      registry.register({
        name: 'get_matchup_fundamentals',
        description: 'Fundamentals',
        parameters: { game_id: { type: 'string', description: 'ID', required: true } },
        execute: async (args: Record<string, any>) => ({
          success: true,
          summary: `[MATCHUP FUNDAMENTALS: ${args.game_id}] Neutral`
        })
      });

      const board = [
        'event_id=nba-401910032 | sport=nba | Denver Nuggets @ Chicago Bulls | commence=2026-11-22T01:00:00Z | options: R20 Denver Nuggets -9.5 (-110)',
        'event_id=nhl-401892770 | sport=nhl | Nashville Predators @ St. Louis Blues | commence=2026-11-22T01:00:00Z | options: R39 St. Louis Blues ML (-126)',
        'event_id=nfl-401873077 | sport=nfl | Buffalo Bills @ Kansas City Chiefs | commence=2026-11-22T21:00:00Z | options: R51 Kansas City Chiefs -2.5 (-110)'
      ].join('\n');

      const proposal = {
        picks: [
          { row: 'R20', side: 'Denver Nuggets -9.5' },
          { row: 'R39', side: 'St. Louis Blues ML' },
          { row: 'R51', side: 'Kansas City Chiefs -2.5' }
        ],
        analysis: 'Three legs verified across NBA, NHL, and NFL.'
      };

      const mockProposer: any = {
        role: 'Manager',
        provider: 'gemini',
        modelName: 'mock-manager',
        run: vi.fn().mockResolvedValue(JSON.stringify(proposal))
      };
      const mockCritic: any = {
        role: 'Critic',
        provider: 'gemini',
        modelName: 'mock-critic',
        run: vi.fn().mockResolvedValue(JSON.stringify({ pass: true, feedback: 'R20, R39, R51 verified.' }))
      };

      const lifecycle = new AnalysisLifecycle(mockProposer, mockCritic, 1, {
        toolRegistry: registry,
        queryCache: new GameQueryCache()
      });

      await lifecycle.executeAndVerify(
        { fullBoard: board },
        new SwarmContext(),
        'Build 3-leg card',
        'Verify 3 legs'
      );

      expect(weatherCalls).not.toContain('nba-401910032');
      expect(weatherCalls).not.toContain('nhl-401892770');
      expect(weatherCalls).toContain('nfl-401873077');
    });

    it('preserves policy price-band phrases verbatim in digest odds scrubber', () => {
      const sentence = 'Both legs are priced within the -220 to +150 window.';
      expect(stripApproximateOdds(sentence)).toBe(sentence);
      expect(sanitizeMoneylinePriceMoves(sentence)).toBe(sentence);

      const betweenPhrase = 'Target legs priced between -220 and +150 and reject legs steeper than -250.';
      expect(stripApproximateOdds(betweenPhrase)).toBe(betweenPhrase);
      expect(sanitizeMoneylinePriceMoves(betweenPhrase)).toBe(betweenPhrase);

      const analystParsed = guardAnalystResponse(
        JSON.stringify({
          insights: [sentence, 'Skip favorites steeper than -250.'],
          summary: sentence
        })
      );
      expect(analystParsed.insights).toContain(sentence);
      expect(analystParsed.summary).toBe(sentence);
    });
  });
});
