/**
 * Types for Render Swarm Morning Slate Engine
 */

export interface EspnLeagueConfig {
  sport: string;
  league: string;
  sportKey: string;
}

export interface SlateGame {
  eventId: string;
  sport: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  gameDate: string;
  weatherSnapshot: Record<string, any> | null;
  oddsSnapshot: {
    provider?: string;
    details?: string | null;
    overUnder?: number | null;
    spread?: number | null;
    awayMoneyLine?: number | null;
    homeMoneyLine?: number | null;
  } | null;
  rawEvent?: any;
}

export interface MorningArgument {
  claim: string;
  advocate: 'quant' | 'market' | 'critic' | 'judge';
  weight: 'high' | 'medium' | 'low';
  supportingData?: string;
}

export interface MorningJudgeOutput {
  likelyWinner: string;
  winProbHome: number;
  winProbAway: number;
  fairSpread: number;
  fairTotal: number | null;
  totalLean: 'over' | 'under' | 'none';
  arguments: MorningArgument[];
  invalidationConditions: string[];
  dataAsOf: string;
  workflowId?: string | null;
}

export interface LineSnapshotInsert {
  event_id: string;
  game_date: string;
  sport: string;
  book: string;
  market: 'all';
  spread: number | null;
  total: number | null;
  ml_home: number | null;
  ml_away: number | null;
  snapshot_at: string;
  is_baseline: boolean;
}

export interface MorningBatchResult {
  ok: boolean;
  gameDate: string;
  judged: number;
  replaced: number;
  skipped: number;
  snapshots: number;
  errors: Array<{ eventId: string; error: string }>;
  settled?: number;
}
