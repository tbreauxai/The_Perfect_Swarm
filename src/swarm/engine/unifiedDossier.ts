import type { SwarmContext } from '../context.ts';
import type { GameHeader } from '../context/gameHeaders.ts';
import type { GameQueryCache } from '../cache/gameQueryCache.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { executeToolWithCacheAndTimeout, TOOL_EXECUTION_TIMEOUT_MS } from './triageExecutor.ts';
import type { ToolEvidenceItem } from './seatToolLoop.ts';
import type { MarketToolRecord } from '../tools/marketRowBinding.ts';
import { isEmptyToolSummary, type ToolCallTraceEntry } from '../tools/pullBeforePass.ts';

const TWO_HOP_DOSSIER_TOOLS = [
  'get_matchup_fundamentals',
  'get_injury_and_roster_delta',
  'get_market_movement',
] as const;

export interface UnifiedDossierSection {
  tool: string;
  event_id: string;
  status: 'ok' | 'empty' | 'error';
  summary: string;
  tokenCost: number;
}

export interface UnifiedDossierTraceEntry {
  tool: string;
  eventId: string;
  status: 'data' | 'empty' | 'error';
  tokenCost: number;
  sectionIndex: number | null;
  durationMs?: number;
  cached?: boolean;
}

export interface UnifiedGameDossierEntry {
  eventId: string;
  matchup: string;
  sport: string;
  rows?: string;
  modelSignal?: string;
  fundamentals?: string;
  injuries?: string;
  market?: string;
  hasDirectionalSteam: boolean;
  outCountDiff: number;
  netMarginGap: number;
}

/**
 * Formats compact R# row mappings (excluding volatile American odds prices)
 * for inline display directly beneath each game's unified dossier header.
 */
export function formatCompactDossierRows(header: GameHeader): string {
  if (!header || !Array.isArray(header.options) || header.options.length === 0) {
    return '';
  }
  return header.options
    .map((opt) => {
      const id = String(opt?.id || '').trim().toUpperCase();
      const rawText = String(opt?.text || '').trim();
      if (!id || !rawText) return '';
      const cleanedText = rawText
        .replace(/\s*\(\s*[+-]\d{3,4}\s*\)\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return cleanedText ? `${id}:${cleanedText}` : '';
    })
    .filter(Boolean)
    .join(' | ');
}

export interface UnifiedSlateDossier {
  mode: 'two-hop-slate';
  active_event_ids: string[];
  sections: UnifiedDossierSection[];
  tool_call_trace: UnifiedDossierTraceEntry[];
  entries: UnifiedGameDossierEntry[];
  toolEvidenceItems: ToolEvidenceItem[];
  marketToolRecords: MarketToolRecord[];
  rawToolCallTrace: ToolCallTraceEntry[];
  coveredEventIds: string[];
  tokenEstimate: number;
  totalDurationMs: number;
}

export interface FormattedUnifiedDossier {
  text: string;
  sectionsIncluded: number;
  fullSectionsIncluded?: number;
  compactSectionsIncluded?: number;
  truncated: boolean;
}

const TOOL_BANNER_ANYWHERE_RE =
  /\[(?:MATCHUP FUNDAMENTALS|INJURY\s*&\s*ROSTER DELTA|MARKET MOVEMENT)[^\]]*\]:?\s*/gi;

/**
 * Strips repeated per-tool header banners and normalizes empty injury boilerplate
 * so per-game dossiers remain compact (~30-40% fewer tokens) without losing facts,
 * while strictly preserving Health Balance and two-sided Steam tags.
 */
export function compressDossierPillarSummary(tool: string, summary: string): string {
  const normTool = tool.replace(/_v1$/i, '').trim();
  const lines = String(summary || '')
    .split(/\r?\n/)
    .map((l) => {
      let cleaned = l.trim().replace(TOOL_BANNER_ANYWHERE_RE, '').trim();
      if (/\bL5:\s*\d+-\d+/i.test(cleaned)) {
        cleaned = cleaned.replace(/\s*\|\s*Recent\s+[WL,\s]+(?=\s*\||$)/gi, '');
      }
      return cleaned.replace(/\bBooks\s+Tracked:\s*/gi, 'Books: ').trim();
    })
    .filter(Boolean);

  if (lines.length === 0) {
    return normTool === 'get_injury_and_roster_delta' ? 'None' : 'Unavailable';
  }

  const joined = lines.join(' | ').replace(/\s+/g, ' ').trim();
  if (
    normTool === 'get_injury_and_roster_delta' &&
    (/^(?:no\s+significant\s+roster\s+deltas\s+or\s+injury\s+tags\s+reported\.?|no\s+injuries\s+reported\.?|no\s+injury\s+report\s+available\.?|none\s+reported\.?)$/i.test(joined) ||
      isEmptyToolSummary(summary))
  ) {
    return 'None';
  }
  return joined;
}

export interface QualitativePillarEvaluation {
  pillarCount: number;
  alignedPillarCount: number;
  winningSide?: 'home' | 'away' | null;
  winningTeam?: string;
  homePillarCount?: number;
  awayPillarCount?: number;
  totalSteamTag?: string;
  tags: string[];
  hasDirectionalSteam: boolean;
  isUncertainQuestionable: boolean;
  outCountDiff: number;
  netMarginGap: number;
  weightedMarginRank: number;
  contraSteamRiskSide?: 'home' | 'away' | null;
  contraSteamTag?: string;
}

function americanOddsToImpliedPct(odds: number): number | null {
  if (!Number.isFinite(odds) || odds === 0) return null;
  if (odds < 0) return (-odds / (-odds + 100)) * 100;
  return (100 / (odds + 100)) * 100;
}

function extractSharpSteamMetrics(rawText: string): { impliedShiftPp: number; spreadMovePts: number } {
  if (!rawText) return { impliedShiftPp: 0, spreadMovePts: 0 };
  let impliedShiftPp = 0;
  let spreadMovePts = 0;

  const ppMatches = rawText.matchAll(/([+-]?\d+(?:\.\d+)?)\s*(?:pp\s*imp(?:lied)?|%\s*imp(?:lied)?|pp\b)/gi);
  for (const m of ppMatches) {
    const v = Math.abs(parseFloat(m[1]));
    if (Number.isFinite(v) && v > impliedShiftPp) impliedShiftPp = v;
  }

  const arrowMatches = rawText.matchAll(/([+-]?\d+(?:\.\d+)?)\s*(?:->|→)\s*([+-]?\d+(?:\.\d+)?)/g);
  for (const m of arrowMatches) {
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (Math.abs(a) >= 100 || Math.abs(b) >= 100) {
      const pA = americanOddsToImpliedPct(a);
      const pB = americanOddsToImpliedPct(b);
      if (pA !== null && pB !== null) {
        const delta = Math.abs(pB - pA);
        if (delta > impliedShiftPp) impliedShiftPp = Math.round(delta * 10) / 10;
      }
    } else if (Math.abs(a) < 50 && Math.abs(b) < 50) {
      const pts = Math.abs(b - a);
      if (pts > spreadMovePts) spreadMovePts = Math.round(pts * 10) / 10;
    }
  }

  const ptsMatch = rawText.match(/([+-]?\d+(?:\.\d+)?)\s*pts?\b/i);
  if (ptsMatch) {
    const pts = Math.abs(parseFloat(ptsMatch[1]));
    if (Number.isFinite(pts) && pts > spreadMovePts) spreadMovePts = pts;
  }

  return { impliedShiftPp, spreadMovePts };
}

interface ParsedTeamLine {
  abbr: string;
  wins: number;
  losses: number;
  pfAvg: number | null;
  netMargin: number | null;
  l5Wins: number | null;
  l5Losses: number | null;
}

function parseSideLineFromFundamentals(text: string, prefix: 'Home' | 'Away'): ParsedTeamLine | null {
  const re = new RegExp(
    `${prefix}\\s*\\(([^)]+)\\)\\s*:\\s*(?:W-L\\s*)?(\\d+)-(\\d+)` +
      `(?:[^|\\n]*\\|\\s*PF\\/PA\\s*([\\d.]+)\\s*\\/\\s*[\\d.]+)?` +
      `[^\\n]*?(?:Net\\s*Margin|Net|Diff)\\s*:?\\s*([+-]?\\d+(?:\\.\\d+)?)` +
      `(?:[^\\n]*?\\bL5:\\s*(\\d+)-(\\d+))?`,
    'i',
  );
  const m = text.match(re);
  if (!m) return null;
  const wins = Number(m[2]);
  const losses = Number(m[3]);
  const pfAvg = m[4] !== undefined ? Number(m[4]) : null;
  const netMargin = m[5] !== undefined ? Number(m[5]) : null;
  const l5Wins = m[6] !== undefined ? Number(m[6]) : null;
  const l5Losses = m[7] !== undefined ? Number(m[7]) : null;
  return {
    abbr: m[1].trim(),
    wins,
    losses,
    pfAvg: Number.isFinite(pfAvg) ? pfAvg : null,
    netMargin: Number.isFinite(netMargin) ? netMargin : null,
    l5Wins: Number.isFinite(l5Wins) ? l5Wins : null,
    l5Losses: Number.isFinite(l5Losses) ? l5Losses : null,
  };
}

function teamNameMatchesLabel(label: string, abbr: string, matchupPart: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const nl = norm(label);
  if (!nl) return false;
  const na = norm(abbr);
  if (na && (nl === na || nl.split(' ').includes(na))) return true;
  const tokens = norm(matchupPart)
    .split(' ')
    .filter((t) => t.length >= 3);
  return tokens.some((tok) => nl === tok || nl.includes(tok));
}

/**
 * Evaluates purely qualitative matchup strength across 3 independent pillars
 * (form_edge, steam_edge, health_edge) without computing EV or implied probability.
 */
export function evaluateQualitativePillars(entry: UnifiedGameDossierEntry): QualitativePillarEvaluation {
  const fund = String(entry.fundamentals || '');
  const inj = String(entry.injuries || '');
  const mkt = String(entry.market || '');
  const matchupParts = String(entry.matchup || '').split('@');
  const awayMatchupName = (matchupParts[0] || '').trim();
  const homeMatchupName = (matchupParts[1] || '').trim();

  const homeSide = parseSideLineFromFundamentals(fund, 'Home');
  const awaySide = parseSideLineFromFundamentals(fund, 'Away');
  const rawMargins = extractNumericMargins(fund);

  const avgPf =
    homeSide?.pfAvg != null && awaySide?.pfAvg != null
      ? (homeSide.pfAvg + awaySide.pfAvg) / 2
      : homeSide?.pfAvg ?? awaySide?.pfAvg ?? null;
  const isLowScoringSport =
    /^(?:nhl|mlb)-/i.test(entry.eventId) ||
    /\b(?:nhl|icehockey_nhl|mlb|baseball_mlb)\b/i.test(entry.sport) ||
    (avgPf !== null && avgPf > 0 && avgPf < 12);

  let formSide: 'home' | 'away' | null = null;
  let formTeam = '';
  let netMarginGap = entry.netMarginGap || 0;

  if (homeSide && awaySide) {
    const hNet = homeSide.netMargin ?? 0;
    const aNet = awaySide.netMargin ?? 0;
    netMarginGap = Math.abs(hNet - aNet);
    const hGp = homeSide.wins + homeSide.losses;
    const aGp = awaySide.wins + awaySide.losses;
    const winPctGap =
      hGp > 0 && aGp > 0 ? Math.abs(homeSide.wins / hGp - awaySide.wins / aGp) : 0;
    const l5WinGap =
      homeSide.l5Wins !== null && awaySide.l5Wins !== null
        ? Math.abs(homeSide.l5Wins - awaySide.l5Wins)
        : 0;
    const clearMargin = isLowScoringSport ? netMarginGap >= 0.7 : netMarginGap >= 2.5;
    if (clearMargin || l5WinGap >= 2 || winPctGap >= 0.25) {
      if (hNet !== aNet) {
        formSide = hNet > aNet ? 'home' : 'away';
      } else if (homeSide.l5Wins !== null && awaySide.l5Wins !== null && homeSide.l5Wins !== awaySide.l5Wins) {
        formSide = homeSide.l5Wins > awaySide.l5Wins ? 'home' : 'away';
      } else {
        formSide = homeSide.wins / Math.max(1, hGp) >= awaySide.wins / Math.max(1, aGp) ? 'home' : 'away';
      }
      formTeam = formSide === 'home' ? homeSide.abbr : awaySide.abbr;
    }
  } else {
    const homeMarginMatch = fund.match(/Home\s*(?:\(([^)]+)\))?\s*:[^|\n]*?(?:Net\s*Margin|Net|Diff)\s*:?\s*([+-]?\d+(?:\.\d+)?)/i);
    const awayMarginMatch = fund.match(/Away\s*(?:\(([^)]+)\))?\s*:[^|\n]*?(?:Net\s*Margin|Net|Diff)\s*:?\s*([+-]?\d+(?:\.\d+)?)/i);
    if (homeMarginMatch && awayMarginMatch) {
      const hVal = Number(homeMarginMatch[2]);
      const aVal = Number(awayMarginMatch[2]);
      netMarginGap = Math.abs(hVal - aVal);
      const clearMargin = isLowScoringSport ? netMarginGap >= 0.7 : netMarginGap >= 2.5;
      if (clearMargin) {
        formSide = hVal >= aVal ? 'home' : 'away';
        formTeam =
          formSide === 'home'
            ? (homeMarginMatch[1]?.trim() || homeMatchupName.split(/\s+/).pop() || 'Home')
            : (awayMarginMatch[1]?.trim() || awayMatchupName.split(/\s+/).pop() || 'Away');
      }
    } else if (rawMargins.length >= 2) {
      netMarginGap = Math.abs(rawMargins[0] - rawMargins[1]);
      const clearMargin = isLowScoringSport ? netMarginGap >= 0.7 : netMarginGap >= 2.5;
      if (clearMargin) {
        const awayIdx = fund.search(/\bAway\b/i);
        const homeIdx = fund.search(/\bHome\b/i);
        const awayFirst = awayIdx !== -1 && (homeIdx === -1 || awayIdx < homeIdx);
        const hVal = awayFirst ? rawMargins[1] : rawMargins[0];
        const aVal = awayFirst ? rawMargins[0] : rawMargins[1];
        formSide = hVal >= aVal ? 'home' : 'away';
        formTeam =
          formSide === 'home'
            ? (homeMatchupName.split(/\s+/).pop() || 'Home')
            : (awayMatchupName.split(/\s+/).pop() || 'Away');
      }
    }
  }

  let steamSide: 'home' | 'away' | null = null;
  let steamTarget = '';
  let totalSteamTag = '';

  const sideSteamExplicit = mkt.match(/Side\s+Steam:\s*TOWARD\s+([^|\n;]+)/i);
  const totalSteamExplicit = mkt.match(/Total\s+Steam:\s*TOWARD\s+([^|\n;]+)/i);
  const genericSteamMatch = !sideSteamExplicit ? mkt.match(/(?:^|[|\n;]\s*)Steam:\s*TOWARD\s+([^|\n;]+)/i) : null;

  const parseSteamCandidate = (raw: string): void => {
    const cleaned = raw.replace(/\s*\([^)]*\)\s*$/g, '').trim();
    if (!cleaned || /^(?:NEUTRAL|NONE|MIXED|N\/A)$/i.test(cleaned)) return;
    if (/^(?:total\s+)?(?:over|under)\b/i.test(cleaned)) {
      if (!totalSteamTag) totalSteamTag = `TOWARD ${cleaned}`;
      return;
    }
    const strippedDir = cleaned.replace(/^(?:home|away)\s+/i, '').trim();
    const explicitHome = /^home\b/i.test(cleaned);
    const explicitAway = /^away\b/i.test(cleaned);
    const matchesHome = explicitHome || teamNameMatchesLabel(strippedDir, homeSide?.abbr || '', homeMatchupName);
    const matchesAway = explicitAway || teamNameMatchesLabel(strippedDir, awaySide?.abbr || '', awayMatchupName);
    if (matchesHome && !matchesAway) {
      steamSide = 'home';
      steamTarget = cleaned;
    } else if (matchesAway && !matchesHome) {
      steamSide = 'away';
      steamTarget = cleaned;
    } else if (/over|under|total/i.test(cleaned)) {
      if (!totalSteamTag) totalSteamTag = `TOWARD ${cleaned}`;
    }
  };

  if (sideSteamExplicit) parseSteamCandidate(sideSteamExplicit[1]);
  if (totalSteamExplicit) {
    const cleanedTotal = totalSteamExplicit[1].replace(/\s*\([^)]*\)\s*$/g, '').trim();
    if (cleanedTotal && !/^(?:NEUTRAL|NONE|MIXED|N\/A)$/i.test(cleanedTotal)) {
      totalSteamTag = `TOWARD ${cleanedTotal}`;
    }
  }
  if (genericSteamMatch) parseSteamCandidate(genericSteamMatch[1]);

  const isUncertainQuestionable = /Health\s*Balance:\s*uncertain_questionable\b/i.test(inj);
  let healthSide: 'home' | 'away' | null = null;
  let healthLabel = '';
  if (!isUncertainQuestionable) {
    const healthMatch = inj.match(/Health\s*Balance:\s*(home_advantage|away_advantage)(?:\s*\(([^)]+)\))?/i);
    if (healthMatch) {
      const cls = healthMatch[1].toLowerCase();
      healthSide = cls === 'home_advantage' ? 'home' : 'away';
      healthLabel = cls;
    }
  }

  // S1.1 (wf-1795638625511): Detect sharp contra-steam (`AGAINST <side>` with >=2.5pp ML implied shift
  // or >=1.0 pt spread move) and penalize that side unless `model_signal` explicitly favors it.
  let contraSteamRiskSide: 'home' | 'away' | null = null;
  let contraSteamTag = '';
  const againstMatch = mkt.match(/\bAGAINST\s+(home|away)\s+([^|\n;]+)/i);
  if (againstMatch) {
    const againstRole = againstMatch[1].toLowerCase() as 'home' | 'away';
    const againstRaw = againstMatch[2].trim();
    const againstTeamClean = againstRaw.replace(/\s*\([^)]*\)\s*/g, '').replace(/\s+(?:ML|moneyline|spread)\s*$/i, '').trim();
    // Measure move across the full Steam segment (covers both TOWARD (...) and AGAINST (...))
    const steamSegMatch = mkt.match(/(?:Side\s+)?Steam:\s*[^\n;]+/i);
    const metrics = extractSharpSteamMetrics(steamSegMatch ? steamSegMatch[0] : mkt);
    const isSharpContra = metrics.impliedShiftPp >= 2.5 || metrics.spreadMovePts >= 1.0;

    const rawModelSig = String(
      entry.modelSignal ||
      `${entry.rows || ''} ${fund} ${mkt}`.match(/\bmodel_signal\s*=\s*(lean_home|lean_away|neutral|none)\b/i)?.[1] ||
      ''
    ).trim().toLowerCase();
    const modelFavorsAgainst =
      (againstRole === 'home' && rawModelSig === 'lean_home') ||
      (againstRole === 'away' && rawModelSig === 'lean_away');

    if (isSharpContra && !modelFavorsAgainst) {
      contraSteamRiskSide = againstRole;
      const shiftLabel = metrics.impliedShiftPp >= 2.5
        ? ` +${metrics.impliedShiftPp.toFixed(1)}pp`
        : (metrics.spreadMovePts >= 1.0 ? ` ${metrics.spreadMovePts.toFixed(1)}pt` : '');
      contraSteamTag = `[contra_steam_risk: AGAINST ${againstRole}${againstTeamClean ? ` ${againstTeamClean}` : ''}${shiftLabel}]`;
    }
  }

  // S5: Score pillars independently per side (home vs away). Never sum opposing sides or count Total steam as a side pillar.
  const homeTags: string[] = [];
  const awayTags: string[] = [];

  if (formSide === 'home' && formTeam) homeTags.push(`form=${formTeam}`);
  else if (formSide === 'away' && formTeam) awayTags.push(`form=${formTeam}`);

  if (steamSide === 'home' && steamTarget) homeTags.push(`steam=TOWARD ${steamTarget}`);
  else if (steamSide === 'away' && steamTarget) awayTags.push(`steam=TOWARD ${steamTarget}`);

  if (healthSide === 'home' && healthLabel) homeTags.push(`health=${healthLabel}`);
  else if (healthSide === 'away' && healthLabel) awayTags.push(`health=${healthLabel}`);

  // Subtract 1 pillar from a side facing sharp contra-steam without model_signal override
  const homeCount = Math.max(0, homeTags.length - (contraSteamRiskSide === 'home' ? 1 : 0));
  const awayCount = Math.max(0, awayTags.length - (contraSteamRiskSide === 'away' ? 1 : 0));

  let winningSide: 'home' | 'away' | null = null;
  if (homeCount > awayCount) {
    winningSide = 'home';
  } else if (awayCount > homeCount) {
    winningSide = 'away';
  } else if (homeCount > 0) {
    // Tie-break: prefer side NOT facing sharp contra-steam, then directional side steam, then health, then home
    if (contraSteamRiskSide === 'away' && homeCount > 0) winningSide = 'home';
    else if (contraSteamRiskSide === 'home' && awayCount > 0) winningSide = 'away';
    else if (steamSide === 'away') winningSide = 'away';
    else if (steamSide === 'home') winningSide = 'home';
    else if (healthSide === 'away') winningSide = 'away';
    else winningSide = 'home';
  }

  const winningTags = winningSide === 'home'
    ? [...homeTags, ...(contraSteamRiskSide === 'home' && contraSteamTag ? [contraSteamTag] : [])]
    : winningSide === 'away'
      ? [...awayTags, ...(contraSteamRiskSide === 'away' && contraSteamTag ? [contraSteamTag] : [])]
      : [];
  const alignedPillarCount = winningSide === 'home' ? homeCount : winningSide === 'away' ? awayCount : 0;
  const resolveTeamLabel = (side: 'home' | 'away' | null): string => {
    if (side === 'home') {
      return homeSide?.abbr || homeMatchupName.split(/\s+/).pop() || 'HOME';
    }
    if (side === 'away') {
      return awaySide?.abbr || awayMatchupName.split(/\s+/).pop() || 'AWAY';
    }
    return '';
  };
  const winningTeam = resolveTeamLabel(winningSide);

  const hasDirectionalSteam = entry.hasDirectionalSteam || steamSide !== null;
  const outCountDiff = isUncertainQuestionable ? 0 : Math.max(entry.outCountDiff || 0, computeOutCountDiff(inj));
  const weightedMarginRank = isLowScoringSport ? netMarginGap * 4 : netMarginGap;

  return {
    pillarCount: alignedPillarCount,
    alignedPillarCount,
    winningSide,
    winningTeam,
    homePillarCount: homeCount,
    awayPillarCount: awayCount,
    ...(totalSteamTag ? { totalSteamTag } : {}),
    ...(contraSteamRiskSide ? { contraSteamRiskSide } : {}),
    ...(contraSteamTag ? { contraSteamTag } : {}),
    tags: winningTags,
    hasDirectionalSteam,
    isUncertainQuestionable,
    outCountDiff,
    netMarginGap,
    weightedMarginRank,
  };
}

function extractNumericMargins(text?: string): number[] {
  if (!text) return [];
  const matches = text.matchAll(/(?:Net\s*Margin|Diff)\s*:?\s*([+-]?\d+(?:\.\d+)?)/gi);
  const out: number[] = [];
  for (const m of matches) {
    const val = Number(m[1]);
    if (Number.isFinite(val)) out.push(val);
  }
  return out;
}

export function computeOutCountDiff(injuriesText?: string): number {
  if (!injuriesText || injuriesText === 'None') return 0;
  const summaryMatch = injuriesText.match(
    /Summary:\s*[^(]+\((\d+)\s+OUT(?:\s*\[impact\s+(\d+(?:\.\d+)?)[^\]]*\]|\s*\[[^\]]*\])?,\s*\d+\s+Q\)\s+vs\s+[^(]+\((\d+)\s+OUT(?:\s*\[impact\s+(\d+(?:\.\d+)?)[^\]]*\]|\s*\[[^\]]*\])?,\s*\d+\s+Q\)/i
  );
  if (summaryMatch) {
    const rawDiff = Math.abs(Number(summaryMatch[1]) - Number(summaryMatch[3]));
    if (summaryMatch[2] !== undefined && summaryMatch[4] !== undefined) {
      const impactDiff = Math.abs(Number(summaryMatch[2]) - Number(summaryMatch[4]));
      if (Number.isFinite(impactDiff)) {
        return Math.max(rawDiff, Math.round(impactDiff * 10) / 10);
      }
    }
    return rawDiff;
  }
  const parts = injuriesText.split('|').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const counts = parts.map((p) => (p.match(/\bOUT\b/gi) || []).length);
    return Math.abs(counts[0] - counts[1]);
  }
  return (injuriesText.match(/\bOUT\b/gi) || []).length;
}

async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

export const HOP1_TOOL_EXECUTION_TIMEOUT_MS = 4000;
export const HOP1_MAX_CONCURRENCY = 6;
const HOP1_HARD_MAX_CONCURRENCY = 8;

function isHop1TimeoutError(error?: string): boolean {
  return /\b(?:timeout|timed\s+out|exceeded\s+\d+ms|AbortError)\b/i.test(String(error || ''));
}

/**
 * Hop 1 Unified 3-Tool Dossier Fetcher:
 * Concurrently executes get_matchup_fundamentals, get_injury_and_roster_delta,
 * and get_market_movement across all active slate games before Hop 2 debate begins.
 */
export async function fetchTwoHopSlateDossier(
  activeHeaders: GameHeader[],
  toolRegistry: ToolRegistry,
  cache: GameQueryCache,
  context?: SwarmContext,
  options?: {
    env?: Record<string, string | undefined>;
    fetchFn?: typeof fetch;
    qdrantClient?: any;
    timeoutMs?: number;
    maxConcurrency?: number;
  },
): Promise<UnifiedSlateDossier> {
  const startTime = Date.now();
  const availableTools = TWO_HOP_DOSSIER_TOOLS.filter((t) => toolRegistry.has(t));
  const activeEventIds = activeHeaders.map((h) => h.eventId).filter(Boolean);
  const timeoutMs = options?.timeoutMs ?? HOP1_TOOL_EXECUTION_TIMEOUT_MS;
  const maxConcurrency = Math.max(
    1,
    Math.min(options?.maxConcurrency ?? HOP1_MAX_CONCURRENCY, HOP1_HARD_MAX_CONCURRENCY)
  );

  if (activeHeaders.length === 0 || availableTools.length === 0) {
    return {
      mode: 'two-hop-slate',
      active_event_ids: activeEventIds,
      sections: [],
      tool_call_trace: [],
      entries: activeHeaders.map((h) => {
        const compactRows = formatCompactDossierRows(h);
        return {
          eventId: h.eventId,
          matchup: `${h.away} @ ${h.home}`,
          sport: h.sport,
          ...(compactRows ? { rows: compactRows } : {}),
          ...(h.modelSignal ? { modelSignal: h.modelSignal } : {}),
          hasDirectionalSteam: false,
          outCountDiff: 0,
          netMarginGap: 0,
        };
      }),
      toolEvidenceItems: [],
      marketToolRecords: [],
      rawToolCallTrace: [],
      coveredEventIds: [],
      tokenEstimate: 0,
      totalDurationMs: 0,
    };
  }

  interface PendingCall {
    header: GameHeader;
    tool: string;
    parameters: Record<string, unknown>;
  }

  const calls: PendingCall[] = [];
  for (const h of activeHeaders) {
    for (const tool of availableTools) {
      calls.push({
        header: h,
        tool,
        parameters:
          tool === 'get_market_movement'
            ? { game_id: h.eventId, market_type: 'all' }
            : { game_id: h.eventId },
      });
    }
  }

  const runPlayerLogsCache = new Map<string, Promise<any[]>>();
  const executed = await runWithConcurrencyLimit(calls, maxConcurrency, async (c) => {
    const execOpts = {
      env: options?.env,
      fetchFn: options?.fetchFn,
      qdrantClient: options?.qdrantClient,
      playerLogsCache: runPlayerLogsCache,
      game: {
        event_id: c.header.eventId,
        sport: c.header.sport,
        home_team: c.header.home,
        away_team: c.header.away,
        home_team_abbr: c.header.home,
        away_team_abbr: c.header.away,
        ...(Array.isArray(c.header.options) && c.header.options.length > 0 ? { options: c.header.options } : {}),
      },
    };

    let res = await executeToolWithCacheAndTimeout(
      { tool: c.tool, parameters: c.parameters },
      { game_id: c.header.eventId },
      toolRegistry,
      cache,
      timeoutMs,
      execOpts,
    );

    // P0-5: Retry once automatically on timeout before recording status: "error".
    if (!res.success && isHop1TimeoutError(res.error)) {
      cache.delete(c.header.eventId, c.tool, c.parameters);
      const retryRes = await executeToolWithCacheAndTimeout(
        { tool: c.tool, parameters: c.parameters },
        { game_id: c.header.eventId },
        toolRegistry,
        cache,
        timeoutMs,
        execOpts,
      );
      res = {
        ...retryRes,
        durationMs: (res.durationMs ?? 0) + (retryRes.durationMs ?? 0),
      };
    }

    if (context?.addEvent) {
      context.addEvent({
        agentRole: 'Hop 1 Dossier Fetch',
        action: `Executed Tool: ${c.tool}`,
        modelName: 'Local/UnifiedHop1',
        prompt: JSON.stringify(c.parameters),
        tool: c.tool,
        output: res.success ? (res.data ?? res.summary) : { error: res.error },
        durationMs: res.durationMs ?? 0,
      });
    }

    return { call: c, res };
  });

  const sections: UnifiedDossierSection[] = [];
  const tool_call_trace: UnifiedDossierTraceEntry[] = [];
  const rawToolCallTrace: ToolCallTraceEntry[] = [];
  const toolEvidenceItems: ToolEvidenceItem[] = [];
  const marketToolRecords: MarketToolRecord[] = [];
  const coveredSet = new Set<string>();
  const entryById = new Map<string, UnifiedGameDossierEntry>();

  for (const h of activeHeaders) {
    const compactRows = formatCompactDossierRows(h);
    entryById.set(h.eventId, {
      eventId: h.eventId,
      matchup: `${h.away} @ ${h.home}`,
      sport: h.sport,
      ...(compactRows ? { rows: compactRows } : {}),
      ...(h.modelSignal ? { modelSignal: h.modelSignal } : {}),
      hasDirectionalSteam: false,
      outCountDiff: 0,
      netMarginGap: 0,
    });
  }

  for (const { call, res } of executed) {
    const eventId = call.header.eventId;
    const rawSummary = typeof res.summary === 'string' ? res.summary.trim() : '';
    const isEmpty = !res.success || res.empty === true || isEmptyToolSummary(rawSummary);
    const traceStatus: 'data' | 'empty' | 'error' = !res.success ? 'error' : isEmpty ? 'empty' : 'data';
    const sectionStatus: 'ok' | 'empty' | 'error' = !res.success ? 'error' : isEmpty ? 'empty' : 'ok';

    rawToolCallTrace.push({
      tool: call.tool,
      eventId,
      status: traceStatus,
      ...(rawSummary ? { summary: rawSummary } : {}),
    });

    let sectionIndex: number | null = null;
    const tokenCost = rawSummary ? Math.ceil(rawSummary.length / 4) : 0;

    if (res.success && rawSummary) {
      sectionIndex = sections.length;
      sections.push({
        tool: call.tool,
        event_id: eventId,
        status: sectionStatus,
        summary: rawSummary,
        tokenCost,
      });
      toolEvidenceItems.push({
        tool: call.tool,
        eventId,
        summary: rawSummary,
      });
      coveredSet.add(eventId);
      if (call.tool === 'get_market_movement') {
        marketToolRecords.push({
          tool: call.tool,
          eventId,
          summary: rawSummary,
          ...(res.data !== undefined ? { data: res.data } : {}),
          ...(Array.isArray(res.markets_covered) ? { markets_covered: res.markets_covered } : {}),
        });
      }
    }

    tool_call_trace.push({
      tool: call.tool,
      eventId,
      status: traceStatus,
      tokenCost,
      sectionIndex,
      durationMs: res.durationMs,
      cached: res.cached,
    });

    const entry = entryById.get(eventId);
    if (entry) {
      const compact = res.success && rawSummary ? compressDossierPillarSummary(call.tool, rawSummary) : undefined;
      if (call.tool === 'get_matchup_fundamentals') {
        entry.fundamentals = compact || 'Unavailable';
        const margins = extractNumericMargins(entry.fundamentals);
        if (margins.length >= 2) {
          entry.netMarginGap = Math.abs(margins[0] - margins[1]);
        }
      } else if (call.tool === 'get_injury_and_roster_delta') {
        entry.injuries = compact || 'None';
        entry.outCountDiff = /Health\s*Balance:\s*uncertain_questionable\b/i.test(entry.injuries)
          ? 0
          : computeOutCountDiff(entry.injuries);
      } else if (call.tool === 'get_market_movement') {
        entry.market = compact || 'Unavailable';
        entry.hasDirectionalSteam = /\bSteam:\s*(?!neutral\b|N\/A\b)/i.test(entry.market);
      }
    }
  }

  const totalSummaryChars = sections.reduce((sum, s) => sum + s.summary.length, 0);
  return {
    mode: 'two-hop-slate',
    active_event_ids: activeEventIds,
    sections,
    tool_call_trace,
    entries: Array.from(entryById.values()),
    toolEvidenceItems,
    marketToolRecords,
    rawToolCallTrace,
    coveredEventIds: Array.from(coveredSet),
    tokenEstimate: Math.ceil(totalSummaryChars / 4),
    totalDurationMs: Date.now() - startTime,
  };
}

function trimFieldPreservingSignal(value: string, maxChars: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const segments = text.split(/\s*\|\s*/).filter(Boolean);
  if (segments.length > 1) {
    const isPrioritySeg = (seg: string): boolean =>
      /^(?:Home\s*\(|Away\s*\(|Summary:|Health\s*Balance:|Steam:|Divergence:|L5:)/i.test(seg);
    const prioritized = [...segments.filter(isPrioritySeg), ...segments.filter((s) => !isPrioritySeg(s))];
    const kept: string[] = [];
    for (const seg of prioritized) {
      const candidate = kept.length > 0 ? `${kept.join(' | ')} | ${seg}` : seg;
      if (candidate.length <= maxChars) {
        kept.push(seg);
      } else if (kept.length === 0) {
        return seg.length > maxChars ? `${seg.slice(0, Math.max(12, maxChars - 1))}…` : seg;
      }
    }
    if (kept.length > 0) return kept.join(' | ');
  }
  return `${text.slice(0, Math.max(12, maxChars - 1)).trimEnd()}…`;
}

function compactInjuryForTightBudget(injRaw: string): string {
  if (!injRaw || injRaw === 'None') return 'None';
  const segments = injRaw.split(/\s*\|\s*/).filter(Boolean);
  const summaryAndBalance = segments.filter((s) =>
    /^(?:Summary:|Health\s*Balance:)/i.test(s.trim()),
  );
  if (summaryAndBalance.length > 0) {
    return summaryAndBalance.join(' | ');
  }
  return injRaw;
}

function formatSingleGameEntry(
  entry: UnifiedGameDossierEntry,
  caps?: { fund: number; inj: number; mkt: number },
  entryOpts?: { compactInjuries?: boolean; omitRows?: boolean },
): string {
  const fundRaw = compressDossierPillarSummary('get_matchup_fundamentals', entry.fundamentals || 'Unavailable');
  const injBase = entry.injuries === 'None'
    ? 'None'
    : compressDossierPillarSummary('get_injury_and_roster_delta', entry.injuries || 'None');
  const injRaw = entryOpts?.compactInjuries ? compactInjuryForTightBudget(injBase) : injBase;
  const mktRaw = compressDossierPillarSummary('get_market_movement', entry.market || 'Unavailable');

  const fund = caps ? trimFieldPreservingSignal(fundRaw, caps.fund) : fundRaw;
  const inj = caps ? trimFieldPreservingSignal(injRaw, caps.inj) : injRaw;
  const mkt = caps ? trimFieldPreservingSignal(mktRaw, caps.mkt) : mktRaw;

  const lines = [`=== GAME DOSSIER: ${entry.eventId} (${entry.matchup}) ===`];
  if (!entryOpts?.omitRows && entry.rows && entry.rows.trim()) {
    lines.push(`Rows: ${entry.rows.trim()}`);
  }
  lines.push(`Fundamentals: ${fund}`, `Injuries: ${inj}`, `Market: ${mkt}`);
  return lines.join('\n');
}

export interface FormatUnifiedDossierOptions {
  preserveOrder?: boolean;
  omitIndexHeader?: boolean;
  compactInjuriesOnTightBudget?: boolean;
  maxFullSections?: number;
}

function formatCompactOneLineEntry(
  entry: UnifiedGameDossierEntry,
  evalInfo: QualitativePillarEvaluation,
  maxLineChars: number = 125,
): string {
  const healthMatch = String(entry.injuries || '').match(/Health\s*Balance:\s*([^|\n]+)/i);
  const healthPart = healthMatch ? `Health: ${healthMatch[1].trim()}` : 'Health: None';
  const steamMatch = String(entry.market || '').match(/Steam:\s*([^|\n]+)/i);
  const steamPart = steamMatch ? `Steam: ${steamMatch[1].trim()}` : 'Steam: NEUTRAL';
  const tagsPart = evalInfo.tags.length > 0 ? evalInfo.tags.join(', ') : `MarginGap ${evalInfo.netMarginGap.toFixed(1)}`;
  const raw = `- ${entry.eventId} (${entry.matchup}): ${tagsPart} | ${healthPart} | ${steamPart}`;
  if (raw.length <= maxLineChars) return raw;
  return `${raw.slice(0, Math.max(24, maxLineChars - 1)).trimEnd()}…`;
}

/**
 * Formats per-game merged dossiers ordered by descending qualitative pillar alignment/count,
 * prepending a compact TOP PILLAR CANDIDATES (QUALITATIVE) index and dynamically fitting full slates
 * inside provider budgets when possible without emitting numeric EV/probabilities.
 */
export function formatUnifiedPerGameDossier(
  entries: UnifiedGameDossierEntry[],
  maxChars?: number,
  options?: FormatUnifiedDossierOptions,
): FormattedUnifiedDossier {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { text: '', sectionsIncluded: 0, fullSectionsIncluded: 0, compactSectionsIncluded: 0, truncated: false };
  }

  const evaluated = entries.map((entry, idx) => ({
    entry,
    idx,
    eval: evaluateQualitativePillars(entry),
  }));

  const priorityTier = (ev: QualitativePillarEvaluation): number => {
    if (ev.alignedPillarCount >= 2 && !ev.isUncertainQuestionable) return 3;
    if (ev.alignedPillarCount >= 2 && ev.isUncertainQuestionable) return 2;
    if (ev.alignedPillarCount === 1 && !ev.isUncertainQuestionable) return 1;
    return 0;
  };

  const sorted = options?.preserveOrder
    ? evaluated
    : [...evaluated].sort((a, b) => {
        const tierDiff = priorityTier(b.eval) - priorityTier(a.eval);
        if (tierDiff !== 0) return tierDiff;
        if (b.eval.alignedPillarCount !== a.eval.alignedPillarCount) {
          return b.eval.alignedPillarCount - a.eval.alignedPillarCount;
        }
        const qA = a.eval.isUncertainQuestionable ? 1 : 0;
        const qB = b.eval.isUncertainQuestionable ? 1 : 0;
        if (qA !== qB) return qA - qB;
        if (b.eval.pillarCount !== a.eval.pillarCount) {
          return b.eval.pillarCount - a.eval.pillarCount;
        }
        const steamA = a.eval.hasDirectionalSteam ? 1 : 0;
        const steamB = b.eval.hasDirectionalSteam ? 1 : 0;
        if (steamB !== steamA) return steamB - steamA;
        if (b.eval.outCountDiff !== a.eval.outCountDiff) {
          return b.eval.outCountDiff - a.eval.outCountDiff;
        }
        if (b.eval.weightedMarginRank !== a.eval.weightedMarginRank) {
          return b.eval.weightedMarginRank - a.eval.weightedMarginRank;
        }
        return a.idx - b.idx;
      });

  let indexHeader = '';
  if (!options?.omitIndexHeader) {
    const strongCandidates = sorted.filter(
      (item) =>
        item.eval.pillarCount >= 2 &&
        !(item.eval.contraSteamRiskSide && item.eval.winningSide === item.eval.contraSteamRiskSide),
    );
    const headerPool =
      strongCandidates.length > 0
        ? strongCandidates.slice(0, 8)
        : sorted.filter((item) => item.eval.pillarCount >= 1).slice(0, 5);
    if (headerPool.length > 0 && (typeof maxChars !== 'number' || maxChars >= 600)) {
      const headerLines = [
        '=== TOP PILLAR CANDIDATES (QUALITATIVE) ===',
        ...headerPool.map((item) => {
          const count = item.eval.pillarCount;
          const sideLabel = item.eval.winningSide
            ? ` (${item.eval.winningSide}${item.eval.winningTeam ? ` ${item.eval.winningTeam}` : ''})`
            : '';
          const totalNote = item.eval.totalSteamTag ? ` | total_steam=${item.eval.totalSteamTag}` : '';
          const contraNote =
            item.eval.contraSteamTag && !item.eval.tags.includes(item.eval.contraSteamTag)
              ? ` | ${item.eval.contraSteamTag}`
              : '';
          return `- ${item.entry.eventId} [${count} pillar${count === 1 ? '' : 's'}${sideLabel}: ${item.eval.tags.join(', ')}]${totalNote}${contraNote}`;
        }),
      ];
      const candidateHeader = headerLines.join('\n');
      if (typeof maxChars !== 'number' || candidateHeader.length + 220 <= maxChars) {
        indexHeader = candidateHeader;
      }
    }
  }

  const isHeavySlate = sorted.length >= 12 && !options?.preserveOrder;
  if (isHeavySlate) {
    const requestedFullLimit = Math.min(options?.maxFullSections ?? 10, 10, sorted.length);

    const assembleHeavySlate = (
      fullLimit: number,
      caps?: { fund: number; inj: number; mkt: number },
      entryOpts?: { compactInjuries?: boolean; omitRows?: boolean },
      compactLineCap: number = 125,
    ): FormattedUnifiedDossier => {
      const fullItems = sorted.slice(0, fullLimit);
      const compactItems = sorted.slice(fullLimit);
      const parts: string[] = indexHeader ? [indexHeader] : [];
      let used = indexHeader ? indexHeader.length : 0;
      let fullIncluded = 0;
      let compactIncluded = 0;
      let truncated = false;

      for (const item of fullItems) {
        const block = formatSingleGameEntry(item.entry, caps, entryOpts);
        const sep = parts.length > 0 ? 2 : 0;
        if (typeof maxChars === 'number' && maxChars > 0 && used + sep + block.length > maxChars) {
          truncated = true;
          break;
        }
        used += sep + block.length;
        parts.push(block);
        fullIncluded++;
      }

      if (compactItems.length > 0) {
        const compactHeader = '=== REMAINING SLATE (COMPACT SUMMARIES) ===';
        const compactLines: string[] = [];
        for (const item of compactItems) {
          const line = formatCompactOneLineEntry(item.entry, item.eval, compactLineCap);
          const candidateBody = [compactHeader, ...compactLines, line].join('\n');
          const sep = parts.length > 0 ? 2 : 0;
          if (typeof maxChars === 'number' && maxChars > 0 && used + sep + candidateBody.length > maxChars) {
            truncated = true;
            break;
          }
          compactLines.push(line);
          compactIncluded++;
        }
        if (compactLines.length > 0) {
          const compactSection = [compactHeader, ...compactLines].join('\n');
          parts.push(compactSection);
        } else if (typeof maxChars === 'number' && maxChars > 0) {
          truncated = true;
        }
      }

      return {
        text: parts.join('\n\n'),
        sectionsIncluded: fullIncluded + compactIncluded,
        fullSectionsIncluded: fullIncluded,
        compactSectionsIncluded: compactIncluded,
        truncated,
      };
    };

    const pass1 = assembleHeavySlate(
      requestedFullLimit,
      { fund: 220, inj: 155, mkt: 160 },
      undefined,
      125,
    );
    if (!pass1.truncated || typeof maxChars !== 'number') {
      return pass1;
    }

    const tighterFull = Math.min(requestedFullLimit, 8);
    const pass2 = assembleHeavySlate(
      tighterFull,
      { fund: 185, inj: 130, mkt: 145 },
      { compactInjuries: true },
      105,
    );
    if (!pass2.truncated) {
      return pass2;
    }

    const compactHeaderLen = '=== REMAINING SLATE (COMPACT SUMMARIES) ==='.length + 2;
    const estCompactCost = compactHeaderLen + Math.max(0, sorted.length - tighterFull) * 96;
    const headerCost = indexHeader ? indexHeader.length + 2 : 0;
    const bodyBudget = maxChars - headerCost - estCompactCost - tighterFull * 95;
    const perGameBody = Math.max(60, Math.floor(bodyBudget / Math.max(1, tighterFull)));
    const fundCap = Math.max(30, Math.floor(perGameBody * 0.42));
    const injCap = Math.max(25, Math.floor(perGameBody * 0.28));
    const mktCap = Math.max(25, perGameBody - fundCap - injCap);
    const pass3 = assembleHeavySlate(
      tighterFull,
      { fund: fundCap, inj: injCap, mkt: mktCap },
      { compactInjuries: true, omitRows: true },
      95,
    );
    if (!pass3.truncated) {
      return pass3;
    }

    for (const fallbackFull of [6, 4, 2]) {
      if (fallbackFull >= tighterFull) continue;
      const fbCompactCost = compactHeaderLen + Math.max(0, sorted.length - fallbackFull) * 90;
      const fbPerGame = Math.max(50, Math.floor((maxChars - headerCost - fbCompactCost - fallbackFull * 95) / fallbackFull));
      const fbPass = assembleHeavySlate(
        fallbackFull,
        {
          fund: Math.max(25, Math.floor(fbPerGame * 0.42)),
          inj: Math.max(20, Math.floor(fbPerGame * 0.28)),
          mkt: Math.max(20, fbPerGame - Math.floor(fbPerGame * 0.70)),
        },
        { compactInjuries: true, omitRows: true },
        88,
      );
      if (!fbPass.truncated || fbPass.sectionsIncluded > pass3.sectionsIncluded) {
        return fbPass;
      }
    }

    return pass3.sectionsIncluded >= pass1.sectionsIncluded ? pass3 : pass1;
  }

  const assemble = (
    caps?: { fund: number; inj: number; mkt: number },
    entryOpts?: { compactInjuries?: boolean; omitRows?: boolean },
  ): FormattedUnifiedDossier => {
    const parts: string[] = indexHeader ? [indexHeader] : [];
    let used = indexHeader ? indexHeader.length : 0;
    let gameBlocksIncluded = 0;
    let truncated = false;

    for (const item of sorted) {
      const block = formatSingleGameEntry(item.entry, caps, entryOpts);
      const sep = parts.length > 0 ? 2 : 0;
      if (typeof maxChars === 'number' && maxChars > 0 && used + sep + block.length > maxChars) {
        truncated = true;
        break;
      }
      used += sep + block.length;
      parts.push(block);
      gameBlocksIncluded++;
    }

    return {
      text: parts.join('\n\n'),
      sectionsIncluded: gameBlocksIncluded,
      fullSectionsIncluded: gameBlocksIncluded,
      compactSectionsIncluded: 0,
      truncated,
    };
  };

  const pass1 = assemble(
    sorted.length >= 8 ? { fund: 290, inj: 215, mkt: 195 } : undefined,
  );
  if (!pass1.truncated || typeof maxChars !== 'number' || sorted.length <= 1) {
    return pass1;
  }

  if (options?.compactInjuriesOnTightBudget) {
    const compactInjPass = assemble(undefined, { compactInjuries: true });
    if (!compactInjPass.truncated) {
      return compactInjPass;
    }
  }

  const measureFixedOverhead = (omitRows: boolean): number => {
    const sepOverhead = Math.max(0, sorted.length - 1) * 2;
    const perEntries = sorted.reduce((sum, item) => {
      const hdrLen = `=== GAME DOSSIER: ${item.entry.eventId} (${item.entry.matchup}) ===`.length;
      const rowsLen = !omitRows && item.entry.rows && item.entry.rows.trim()
        ? 1 + `Rows: ${item.entry.rows.trim()}`.length
        : 0;
      // \nFundamentals: \nInjuries: \nMarket:  => 37 chars
      return sum + hdrLen + rowsLen + 37;
    }, 0);
    return perEntries + sepOverhead;
  };

  const headerCost = indexHeader ? indexHeader.length + 2 : 0;
  const totalBodyBudget = maxChars - headerCost - measureFixedOverhead(false);
  const perGameBody = Math.floor(totalBodyBudget / sorted.length);
  const minPerGameBody = options?.compactInjuriesOnTightBudget ? 90 : 160;
  if (perGameBody >= minPerGameBody) {
    const fundCap = Math.max(options?.compactInjuriesOnTightBudget ? 30 : 70, Math.floor(perGameBody * 0.42));
    const injCap = Math.max(options?.compactInjuriesOnTightBudget ? 30 : 60, Math.floor(perGameBody * 0.30));
    const mktCap = Math.max(options?.compactInjuriesOnTightBudget ? 25 : 55, perGameBody - fundCap - injCap);
    const pass2 = assemble(
      { fund: fundCap, inj: injCap, mkt: mktCap },
      options?.compactInjuriesOnTightBudget ? { compactInjuries: true } : undefined,
    );
    if (!pass2.truncated) {
      return pass2;
    }
    if (!options?.compactInjuriesOnTightBudget && pass2.sectionsIncluded >= pass1.sectionsIncluded) {
      return pass2;
    }
  }

  if (options?.compactInjuriesOnTightBudget) {
    const noRowsBodyBudget = maxChars - headerCost - measureFixedOverhead(true);
    const noRowsPerGameBody = Math.max(45, Math.floor(noRowsBodyBudget / sorted.length));
    const fundCap = Math.max(15, Math.floor(noRowsPerGameBody * 0.40));
    const injCap = Math.max(15, Math.floor(noRowsPerGameBody * 0.30));
    const mktCap = Math.max(15, noRowsPerGameBody - fundCap - injCap);
    const pass3 = assemble(
      { fund: fundCap, inj: injCap, mkt: mktCap },
      { compactInjuries: true, omitRows: true },
    );
    if (!pass3.truncated || pass3.sectionsIncluded >= pass1.sectionsIncluded) {
      return pass3;
    }
  }

  return pass1;
}

/**
 * Builds a scoped merged dossier containing only the specified target event IDs
 * (in exact targetEventIds order), fitting <= 4 proposed games within tight Critic budgets.
 */
export function buildScopedUnifiedDossier(
  entries: UnifiedGameDossierEntry[],
  targetEventIds: string[],
  maxChars?: number,
): FormattedUnifiedDossier {
  if (!Array.isArray(entries) || entries.length === 0 || !Array.isArray(targetEventIds) || targetEventIds.length === 0) {
    return { text: '', sectionsIncluded: 0, truncated: false };
  }
  const byId = new Map<string, UnifiedGameDossierEntry>();
  for (const e of entries) {
    if (e?.eventId && !byId.has(e.eventId)) {
      byId.set(e.eventId, e);
    }
  }
  const seen = new Set<string>();
  const scoped: UnifiedGameDossierEntry[] = [];
  for (const rawId of targetEventIds) {
    const id = String(rawId || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entry = byId.get(id);
    if (entry) scoped.push(entry);
  }
  if (scoped.length === 0) {
    return { text: '', sectionsIncluded: 0, truncated: false };
  }
  return formatUnifiedPerGameDossier(scoped, maxChars, {
    preserveOrder: true,
    omitIndexHeader: true,
    compactInjuriesOnTightBudget: true,
  });
}

/**
 * When proposers return 0 picks, deterministically picks the top games with directional steam
 * or strongest form/health asymmetry for Risk Critic pass verification.
 */
export function selectTopPassAuditEventIds(
  entries: UnifiedGameDossierEntry[],
  fallbackHeaders: GameHeader[],
  limit: number = 4,
): string[] {
  if (entries.length > 0) {
    const ranked = [...entries].sort((a, b) => {
      const scoreA = (a.hasDirectionalSteam ? 10 : 0) + a.outCountDiff * 2 + Math.min(10, a.netMarginGap);
      const scoreB = (b.hasDirectionalSteam ? 10 : 0) + b.outCountDiff * 2 + Math.min(10, b.netMarginGap);
      return scoreB - scoreA;
    });
    return ranked.slice(0, limit).map((e) => e.eventId);
  }
  return fallbackHeaders.slice(0, limit).map((h) => h.eventId).filter(Boolean);
}

/**
 * Produces the serializable curatedDossier object stored on SwarmWorkflowResult and emitted on SSE
 * without redundant markdown or duplicate trace summaries.
 */
export function toSerializableCuratedDossier(
  dossier: UnifiedSlateDossier,
  seatVisibility: Array<Record<string, any>> = [],
) {
  return {
    mode: dossier.mode,
    active_event_ids: dossier.active_event_ids,
    sections: dossier.sections,
    tool_call_trace: dossier.tool_call_trace,
    seat_visibility: seatVisibility,
    tokenEstimate: dossier.tokenEstimate,
    totalDurationMs: dossier.totalDurationMs,
  };
}
