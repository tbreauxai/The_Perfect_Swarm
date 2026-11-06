import type { SwarmTool } from './types.ts';
import {
  getSupabaseConfig,
  fetchOnDemandSupabaseContext
} from '../morning/supabase.ts';

/**
 * Built-in tool allowing Swarm analysts to pull live odds snapshots, line movement steam,
 * and historical/active game judgments directly from the DuelOdds Supabase database on-demand.
 */
export const dueloddsSupabaseLookupTool: SwarmTool = {
  name: 'duelodds_supabase_lookup',
  description:
    'Pulls live and historical sports market data directly from the DuelOdds Supabase database (game_judgments and line_snapshots) on-demand by eventId, team name, sport, or gameDate. Refuses unfiltered pulls.',
  parameters: {
    eventId: {
      type: 'string',
      description: 'Optional specific game event_id (e.g., "nba-401584000") to fetch line movement snapshots and judgments for.'
    },
    team: {
      type: 'string',
      description: 'Optional team name substring (e.g., "Lakers", "Celtics", "Yankees") to pull recent judgments and calibration history.'
    },
    sport: {
      type: 'string',
      description: 'Optional sport key filter (e.g., "NBA", "NFL", "MLB", "NHL", "NCAAB").'
    },
    gameDate: {
      type: 'string',
      description: 'Optional YYYY-MM-DD date filter (e.g., "2026-11-06").'
    },
    limit: {
      type: 'number',
      description: 'Maximum rows to pull (1 to 25, default 8).'
    }
  },
  execute: async (args: Record<string, any>) => {
    const cfg = getSupabaseConfig();
    if (!cfg) {
      return {
        configured: false,
        error: 'supabase_not_configured',
        message: 'Supabase credentials (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY) are not configured in the environment.'
      };
    }

    const result = await fetchOnDemandSupabaseContext(cfg, {
      eventId: typeof args?.eventId === 'string' ? args.eventId : undefined,
      team: typeof args?.team === 'string' ? args.team : undefined,
      sport: typeof args?.sport === 'string' ? args.sport : undefined,
      gameDate: typeof args?.gameDate === 'string' ? args.gameDate : undefined,
      limit: typeof args?.limit === 'number' ? args.limit : 8
    });

    return {
      configured: true,
      judgmentsCount: result.judgments.length,
      lineSnapshotsCount: result.lineSnapshots.length,
      error: result.error,
      detail: result.detail,
      summary: result.formattedBlock || result.detail || 'No matching rows found in DuelOdds Supabase tables.',
      judgments: result.judgments,
      lineSnapshots: result.lineSnapshots
    };
  }
};
