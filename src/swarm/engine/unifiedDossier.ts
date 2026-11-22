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
  fundamentals?: string;
  injuries?: string;
  market?: string;
  hasDirectionalSteam: boolean;
  outCountDiff: number;
  netMarginGap: number;
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

const TOOL_BANNER_PREFIX_RE =
  /^\[(?:MATCHUP FUNDAMENTALS|INJURY\s*&\s*ROSTER DELTA|MARKET MOVEMENT)[^\]]*\]:?\s*/i;

/**
 * Strips repeated per-tool header banners and normalizes empty injury boilerplate
 * so per-game dossiers remain compact (~30% fewer tokens) without losing facts.
 */
export function compressDossierPillarSummary(tool: string, summary: string): string {
  const normTool = tool.replace(/_v1$/i, '').trim();
  const lines = String(summary || '')
    .split(/\r?\n/)
    .map((l) => l.trim().replace(TOOL_BANNER_PREFIX_RE, '').trim())
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

function computeOutCountDiff(injuriesText?: string): number {
  if (!injuriesText || injuriesText === 'None') return 0;
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
      entries: activeHeaders.map((h) => ({
        eventId: h.eventId,
        matchup: `${h.away} @ ${h.home}`,
        sport: h.sport,
        hasDirectionalSteam: false,
        outCountDiff: 0,
        netMarginGap: 0,
      })),
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
    entryById.set(h.eventId, {
      eventId: h.eventId,
      matchup: `${h.away} @ ${h.home}`,
      sport: h.sport,
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

function formatSingleGameEntry(entry: UnifiedGameDossierEntry): string {
  return [
    `=== GAME DOSSIER: ${entry.eventId} (${entry.matchup}) ===`,
    `Fundamentals: ${entry.fundamentals || 'Unavailable'}`,
    `Injuries: ${entry.injuries || 'None'}`,
    `Market: ${entry.market || 'Unavailable'}`,
  ].join('\n');
}

/**
 * Formats per-game merged dossiers in canonical event order.
 * Only omits trailing whole game blocks if maxChars is exceeded (never mid-word).
 */
export function formatUnifiedPerGameDossier(
  entries: UnifiedGameDossierEntry[],
  maxChars?: number,
): FormattedUnifiedDossier {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { text: '', sectionsIncluded: 0, truncated: false };
  }
  const blocks: string[] = [];
  let used = 0;
  let truncated = false;

  for (const entry of entries) {
    const block = formatSingleGameEntry(entry);
    const sep = blocks.length > 0 ? 2 : 0;
    if (typeof maxChars === 'number' && maxChars > 0 && used + sep + block.length > maxChars) {
      truncated = true;
      break;
    }
    used += sep + block.length;
    blocks.push(block);
  }

  return {
    text: blocks.join('\n\n'),
    sectionsIncluded: blocks.length,
    truncated,
  };
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
