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
  tags: string[];
  hasDirectionalSteam: boolean;
  outCountDiff: number;
  netMarginGap: number;
  weightedMarginRank: number;
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
  } else if (rawMargins.length >= 2) {
    netMarginGap = Math.abs(rawMargins[0] - rawMargins[1]);
    const clearMargin = isLowScoringSport ? netMarginGap >= 0.7 : netMarginGap >= 2.5;
    if (clearMargin) {
      formSide = rawMargins[0] >= rawMargins[1] ? 'home' : 'away';
      formTeam =
        formSide === 'home'
          ? (homeMatchupName.split(/\s+/).pop() || 'Home')
          : (awayMatchupName.split(/\s+/).pop() || 'Away');
    }
  }

  let steamSide: 'home' | 'away' | 'total' | null = null;
  let steamTarget = '';
  const steamMatch = mkt.match(/Steam:\s*TOWARD\s+([^|\n;]+)/i);
  if (steamMatch) {
    const rawTarget = steamMatch[1]
      .replace(/\s*\([^)]*\)\s*$/g, '')
      .trim();
    if (rawTarget && !/^(?:NEUTRAL|NONE|MIXED|N\/A)$/i.test(rawTarget)) {
      steamTarget = rawTarget;
      const matchesHome = teamNameMatchesLabel(rawTarget, homeSide?.abbr || '', homeMatchupName);
      const matchesAway = teamNameMatchesLabel(rawTarget, awaySide?.abbr || '', awayMatchupName);
      if (matchesHome && !matchesAway) steamSide = 'home';
      else if (matchesAway && !matchesHome) steamSide = 'away';
      else steamSide = 'total';
    }
  }

  let healthSide: 'home' | 'away' | null = null;
  let healthLabel = '';
  const healthMatch = inj.match(/Health\s*Balance:\s*(home_advantage|away_advantage)(?:\s*\(([^)]+)\))?/i);
  if (healthMatch) {
    const cls = healthMatch[1].toLowerCase();
    healthSide = cls === 'home_advantage' ? 'home' : 'away';
    healthLabel = cls;
  }

  const tags: string[] = [];
  if (formSide && formTeam) tags.push(`form=${formTeam}`);
  if (steamSide && steamTarget) tags.push(`steam=TOWARD ${steamTarget}`);
  if (healthSide && healthLabel) tags.push(`health=${healthLabel}`);

  const homeAligned =
    (formSide === 'home' ? 1 : 0) +
    (steamSide === 'home' ? 1 : 0) +
    (healthSide === 'home' ? 1 : 0);
  const awayAligned =
    (formSide === 'away' ? 1 : 0) +
    (steamSide === 'away' ? 1 : 0) +
    (healthSide === 'away' ? 1 : 0);
  const bestDirectionalAligned = Math.max(homeAligned, awayAligned);
  const alignedPillarCount =
    steamSide === 'total' && bestDirectionalAligned > 0
      ? bestDirectionalAligned + 1
      : bestDirectionalAligned;

  const hasDirectionalSteam = entry.hasDirectionalSteam || steamSide !== null;
  const outCountDiff = Math.max(entry.outCountDiff || 0, computeOutCountDiff(inj));
  const weightedMarginRank = isLowScoringSport ? netMarginGap * 4 : netMarginGap;

  return {
    pillarCount: tags.length,
    alignedPillarCount,
    tags,
    hasDirectionalSteam,
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
    /Summary:\s*[^(]+\((\d+)\s+OUT,\s*\d+\s+Q\)\s+vs\s+[^(]+\((\d+)\s+OUT,\s*\d+\s+Q\)/i
  );
  if (summaryMatch) {
    return Math.abs(Number(summaryMatch[1]) - Number(summaryMatch[2]));
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
  options?: { env?: Record<string, string | undefined>; fetchFn?: typeof fetch; qdrantClient?: any; timeoutMs?: number },
): Promise<UnifiedSlateDossier> {
  const startTime = Date.now();
  const availableTools = TWO_HOP_DOSSIER_TOOLS.filter((t) => toolRegistry.has(t));
  const activeEventIds = activeHeaders.map((h) => h.eventId).filter(Boolean);
  const timeoutMs = options?.timeoutMs ?? TOOL_EXECUTION_TIMEOUT_MS;

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

  const executed = await runWithConcurrencyLimit(calls, 6, async (c) => {
    const res = await executeToolWithCacheAndTimeout(
      { tool: c.tool, parameters: c.parameters },
      { game_id: c.header.eventId },
      toolRegistry,
      cache,
      timeoutMs,
      {
        env: options?.env,
        fetchFn: options?.fetchFn,
        qdrantClient: options?.qdrantClient,
        game: {
          event_id: c.header.eventId,
          sport: c.header.sport,
          home_team: c.header.home,
          away_team: c.header.away,
          home_team_abbr: c.header.home,
          away_team_abbr: c.header.away,
          ...(Array.isArray(c.header.options) && c.header.options.length > 0 ? { options: c.header.options } : {}),
        },
      },
    );

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
        entry.outCountDiff = computeOutCountDiff(entry.injuries);
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

function formatSingleGameEntry(
  entry: UnifiedGameDossierEntry,
  caps?: { fund: number; inj: number; mkt: number },
): string {
  const fundRaw = compressDossierPillarSummary('get_matchup_fundamentals', entry.fundamentals || 'Unavailable');
  const injRaw = entry.injuries === 'None'
    ? 'None'
    : compressDossierPillarSummary('get_injury_and_roster_delta', entry.injuries || 'None');
  const mktRaw = compressDossierPillarSummary('get_market_movement', entry.market || 'Unavailable');

  const fund = caps ? trimFieldPreservingSignal(fundRaw, caps.fund) : fundRaw;
  const inj = caps ? trimFieldPreservingSignal(injRaw, caps.inj) : injRaw;
  const mkt = caps ? trimFieldPreservingSignal(mktRaw, caps.mkt) : mktRaw;

  const lines = [`=== GAME DOSSIER: ${entry.eventId} (${entry.matchup}) ===`];
  if (entry.rows && entry.rows.trim()) {
    lines.push(`Rows: ${entry.rows.trim()}`);
  }
  lines.push(`Fundamentals: ${fund}`, `Injuries: ${inj}`, `Market: ${mkt}`);
  return lines.join('\n');
}

/**
 * Formats per-game merged dossiers ordered by descending qualitative pillar alignment/count,
 * prepending a compact TOP PILLAR CANDIDATES (QUALITATIVE) index and dynamically fitting full slates
 * inside provider budgets when possible without emitting numeric EV/probabilities.
 */
export function formatUnifiedPerGameDossier(
  entries: UnifiedGameDossierEntry[],
  maxChars?: number,
): FormattedUnifiedDossier {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { text: '', sectionsIncluded: 0, truncated: false };
  }

  const evaluated = entries.map((entry, idx) => ({
    entry,
    idx,
    eval: evaluateQualitativePillars(entry),
  }));

  const sorted = [...evaluated].sort((a, b) => {
    if (b.eval.alignedPillarCount !== a.eval.alignedPillarCount) {
      return b.eval.alignedPillarCount - a.eval.alignedPillarCount;
    }
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
  const strongCandidates = sorted.filter((item) => item.eval.pillarCount >= 2);
  const headerPool =
    strongCandidates.length > 0
      ? strongCandidates.slice(0, 8)
      : sorted.filter((item) => item.eval.pillarCount >= 1).slice(0, 5);
  if (headerPool.length > 0 && (typeof maxChars !== 'number' || maxChars >= 600)) {
    const headerLines = [
      '=== TOP PILLAR CANDIDATES (QUALITATIVE) ===',
      ...headerPool.map(
        (item) =>
          `- ${item.entry.eventId} [${item.eval.pillarCount} pillar${item.eval.pillarCount === 1 ? '' : 's'}: ${item.eval.tags.join(', ')}]`,
      ),
    ];
    const candidateHeader = headerLines.join('\n');
    if (typeof maxChars !== 'number' || candidateHeader.length + 220 <= maxChars) {
      indexHeader = candidateHeader;
    }
  }

  const assemble = (caps?: { fund: number; inj: number; mkt: number }): FormattedUnifiedDossier => {
    const parts: string[] = indexHeader ? [indexHeader] : [];
    let used = indexHeader ? indexHeader.length : 0;
    let gameBlocksIncluded = 0;
    let truncated = false;

    for (const item of sorted) {
      const block = formatSingleGameEntry(item.entry, caps);
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
      truncated,
    };
  };

  const pass1 = assemble(
    sorted.length >= 8 ? { fund: 290, inj: 215, mkt: 195 } : undefined,
  );
  if (!pass1.truncated || typeof maxChars !== 'number' || sorted.length <= 1) {
    return pass1;
  }

  const avgRowsOverhead = Math.ceil(
    sorted.reduce((sum, item) => sum + (item.entry.rows ? item.entry.rows.trim().length + 7 : 0), 0) /
      Math.max(1, sorted.length),
  );
  const overheadPerGame = 105 + avgRowsOverhead;
  const headerCost = indexHeader ? indexHeader.length + 2 : 0;
  const totalBodyBudget = maxChars - headerCost - sorted.length * overheadPerGame;
  const perGameBody = Math.floor(totalBodyBudget / sorted.length);
  if (perGameBody >= 160) {
    const fundCap = Math.max(70, Math.floor(perGameBody * 0.43));
    const injCap = Math.max(60, Math.floor(perGameBody * 0.30));
    const mktCap = Math.max(55, perGameBody - fundCap - injCap);
    const pass2 = assemble({ fund: fundCap, inj: injCap, mkt: mktCap });
    if (pass2.sectionsIncluded >= pass1.sectionsIncluded) {
      return pass2;
    }
  }

  return pass1;
}

/**
 * Builds a scoped merged dossier containing only the specified target event IDs
 * (in canonical entry order), respecting optional maxChars at whole-game boundaries.
 */
export function buildScopedUnifiedDossier(
  entries: UnifiedGameDossierEntry[],
  targetEventIds: string[],
  maxChars?: number,
): FormattedUnifiedDossier {
  if (!Array.isArray(entries) || entries.length === 0 || !Array.isArray(targetEventIds) || targetEventIds.length === 0) {
    return { text: '', sectionsIncluded: 0, truncated: false };
  }
  const targetSet = new Set(targetEventIds.map((id) => String(id).trim()).filter(Boolean));
  const scoped = entries.filter((e) => targetSet.has(e.eventId));
  return formatUnifiedPerGameDossier(scoped, maxChars);
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
