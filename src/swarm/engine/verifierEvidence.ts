import { parseGameHeaders, type GameHeader } from '../context/gameHeaders.ts';
import type { ToolEvidenceItem } from './seatToolLoop.ts';
import { isEmptyToolSummary } from '../tools/pullBeforePass.ts';

function normalizeEvidenceToolName(name: string): string {
  return String(name || '').trim().replace(/_v1$/i, '');
}

const INJURY_HEADER_PREFIX = /^\[INJURY[^\]]*\]:?\s*/i;
const MARKET_HEADER_PREFIX = /^\[MARKET MOVEMENT[^\]]*\]:?\s*/i;
const GENERIC_TOOL_HEADER_PREFIX = /^\[(?:MATCHUP FUNDAMENTALS|MARKET MOVEMENT|PLAYER PROP|ENVIRONMENT|INJURY[^\]]*)\]:?\s*/i;

function compactInjurySummary(summary: string): string {
  const lines = summary
    .split(/\r?\n/)
    .map(l => l.trim().replace(INJURY_HEADER_PREFIX, '').trim())
    .filter(Boolean);
  if (lines.length === 0) return 'No injuries reported';

  const statusRegex = /\b(OUT|DOUBTFUL|QUESTIONABLE|IR|INJURED\s+RESERVE|SUSPENDED)\b/i;
  const keptTeams: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/^-\s*/, '');
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0 && !/:\s*(OUT|DOUBTFUL|QUESTIONABLE|PROBABLE|IR|SUSPENDED)\b/i.test(line.slice(0, colonIdx + 12))) {
      // Team-grouped format: "BAL: Lamar Jackson (QB): OUT; Adisa Isaac: QUESTIONABLE"
      const team = line.slice(0, colonIdx).trim();
      const rest = line.slice(colonIdx + 1).trim();
      const filteredPlayers = rest
        .split(';')
        .map(p => p.trim())
        .filter(p => statusRegex.test(p));
      if (filteredPlayers.length > 0) {
        keptTeams.push(`${team}: ${filteredPlayers.join('; ')}`);
      }
    } else if (statusRegex.test(line)) {
      keptTeams.push(line);
    }
  }
  return (keptTeams.length > 0 ? keptTeams.join(' | ') : lines.join(' | ')).replace(/\s+/g, ' ').trim();
}

function compactMarketSummary(summary: string): string {
  const lines = summary
    .split(/\r?\n/)
    .map(l => l.trim().replace(MARKET_HEADER_PREFIX, '').trim())
    .filter(Boolean);
  if (lines.length === 0) return summary.replace(/\s+/g, ' ').trim().slice(0, 220);

  const mlAndTotal = lines.filter(l => /^(?:ML|Total):/i.test(l) || /\b(?:ml_home|ml_away)\b/i.test(l));
  const steamLines = lines.filter(l => /^Steam:\s*(?!neutral\b)/i.test(l));
  const primary = lines.filter(
    l =>
      !mlAndTotal.includes(l) &&
      !steamLines.includes(l) &&
      !/^Steam:\s*neutral\b[^|]*\|\s*Divergence:\s*(?:none|single_book|single_book_only)$/i.test(l)
  );
  const ordered = [...primary, ...mlAndTotal, ...steamLines];
  const joined = ordered.join(' | ').replace(/\s+/g, ' ').trim();
  if (joined.length <= 280) return joined;

  // Keep ML/Total and directional Steam intact even if primary Open/Current is verbose
  const priorityPart = [...mlAndTotal, ...steamLines].join(' | ').replace(/\s+/g, ' ').trim();
  if (priorityPart && priorityPart.length < 250) {
    const rem = 280 - priorityPart.length - 3;
    const primJoined = primary.join(' | ').replace(/\s+/g, ' ').trim();
    const primCut = rem > 20 ? `${primJoined.slice(0, rem - 1).trimEnd()}…` : '';
    return primCut ? `${primCut} | ${priorityPart}` : priorityPart;
  }
  return `${joined.slice(0, 277).trimEnd()}…`;
}

export function compactToolLine(tool: string, summary: string): string {
  const normTool = normalizeEvidenceToolName(tool);
  if (normTool === 'get_injury_and_roster_delta') {
    return `INJ: ${compactInjurySummary(summary)}`;
  }
  if (normTool === 'get_market_movement') {
    return `MKT: ${compactMarketSummary(summary)}`;
  }
  const stripped = summary
    .split(/\r?\n/)
    .map(l => l.trim().replace(GENERIC_TOOL_HEADER_PREFIX, '').trim())
    .filter(Boolean)
    .join(' | ')
    .replace(/\s+/g, ' ')
    .trim();
  const body = stripped || summary.replace(/\s+/g, ' ').trim();
  const maxLen = normTool === 'get_matchup_fundamentals' ? 280 : 140;
  const cut = body.length > maxLen ? `${body.slice(0, maxLen - 3).trimEnd()}…` : body;
  if (normTool === 'get_matchup_fundamentals') return `FUND: ${cut}`;
  return `${normTool}: ${cut}`;
}

/**
 * Builds a deduplicated, slate-ordered, game-grouped evidence digest for the verifier
 * from all seats' structured `toolEvidenceItems`.
 */
export function buildVerifierEvidence(
  reports: Array<{ toolEvidenceItems?: ToolEvidenceItem[] }>,
  slateSource?: unknown,
  priorityEventIds?: string[]
): string {
  const deduped = new Map<string, ToolEvidenceItem>();
  for (const r of reports || []) {
    const items = Array.isArray(r?.toolEvidenceItems) ? r.toolEvidenceItems : [];
    for (const item of items) {
      if (!item || !item.tool || !item.eventId || !item.summary) continue;
      const normTool = normalizeEvidenceToolName(item.tool);
      const cleanSummary = item.summary.trim();
      if (!cleanSummary) continue;
      const key = `${normTool}::${item.eventId}`;
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, { tool: normTool, eventId: item.eventId, summary: cleanSummary });
      } else {
        const existingEmpty = isEmptyToolSummary(existing.summary);
        const incomingEmpty = isEmptyToolSummary(cleanSummary);
        if ((existingEmpty && !incomingEmpty) || (!incomingEmpty && cleanSummary.length > existing.summary.length)) {
          deduped.set(key, { tool: normTool, eventId: item.eventId, summary: cleanSummary });
        }
      }
    }
  }
  if (deduped.size === 0) return '';

  const headers = parseGameHeaders(slateSource);
  const headerById = new Map<string, GameHeader>();
  const orderedIds: string[] = [];
  for (const pId of priorityEventIds || []) {
    if (pId && !orderedIds.includes(pId)) {
      orderedIds.push(pId);
    }
  }
  for (const h of headers) {
    if (h.eventId && !headerById.has(h.eventId)) {
      headerById.set(h.eventId, h);
      if (!orderedIds.includes(h.eventId)) {
        orderedIds.push(h.eventId);
      }
    }
  }

  const byEvent = new Map<string, ToolEvidenceItem[]>();
  for (const item of deduped.values()) {
    if (!byEvent.has(item.eventId)) {
      byEvent.set(item.eventId, []);
      if (!orderedIds.includes(item.eventId)) {
        orderedIds.push(item.eventId);
      }
    }
    byEvent.get(item.eventId)!.push(item);
  }

  const toolOrder = (t: string): number => {
    const norm = normalizeEvidenceToolName(t);
    if (norm === 'get_injury_and_roster_delta') return 0;
    if (norm === 'get_matchup_fundamentals') return 1;
    if (norm === 'get_market_movement') return 2;
    return 3;
  };

  const blocks: string[] = [];
  for (const eventId of orderedIds) {
    const items = byEvent.get(eventId);
    if (!items || items.length === 0) continue;
    items.sort((a, b) => toolOrder(a.tool) - toolOrder(b.tool) || a.tool.localeCompare(b.tool));
    const hdr = headerById.get(eventId);
    const title = hdr && hdr.away && hdr.home
      ? `EVENT ${eventId} ${hdr.away} @ ${hdr.home}`
      : `EVENT ${eventId}`;
    const lines = [title, ...items.map(i => compactToolLine(i.tool, i.summary))];
    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n');
}
