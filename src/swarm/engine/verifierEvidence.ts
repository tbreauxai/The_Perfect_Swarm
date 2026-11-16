import { parseGameHeaders, type GameHeader } from '../context/gameHeaders.ts';
import type { ToolEvidenceItem } from './seatToolLoop.ts';

function compactInjurySummary(summary: string): string {
  const lines = summary
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !/^\[INJURY\b/i.test(l));
  if (lines.length === 0) return 'No injuries reported';

  const keptTeams: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/^-\s*/, '');
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0 && !/:\s*(OUT|DOUBTFUL|QUESTIONABLE|PROBABLE)\b/i.test(line.slice(0, colonIdx + 12))) {
      // Team-grouped format: "BAL: Lamar Jackson (QB): OUT; Adisa Isaac: QUESTIONABLE"
      const team = line.slice(0, colonIdx).trim();
      const rest = line.slice(colonIdx + 1).trim();
      const filteredPlayers = rest
        .split(';')
        .map(p => p.trim())
        .filter(p => /\b(OUT|DOUBTFUL|QUESTIONABLE)\b/i.test(p));
      if (filteredPlayers.length > 0) {
        keptTeams.push(`${team}: ${filteredPlayers.join('; ')}`);
      }
    } else if (/\b(OUT|DOUBTFUL|QUESTIONABLE)\b/i.test(line)) {
      keptTeams.push(line);
    }
  }
  return (keptTeams.length > 0 ? keptTeams.join(' | ') : lines.join(' | ')).replace(/\s+/g, ' ').trim();
}

function compactToolLine(tool: string, summary: string): string {
  if (tool === 'get_injury_and_roster_delta') {
    return `INJ: ${compactInjurySummary(summary)}`;
  }
  const stripped = summary
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !/^\[(?:MATCHUP FUNDAMENTALS|MARKET MOVEMENT|PLAYER PROP|ENVIRONMENT)\b/i.test(l))
    .join(' | ')
    .replace(/\s+/g, ' ')
    .trim();
  const body = stripped || summary.replace(/\s+/g, ' ').trim();
  const cut = body.length > 140 ? `${body.slice(0, 137).trimEnd()}…` : body;
  if (tool === 'get_matchup_fundamentals') return `FUND: ${cut}`;
  if (tool === 'get_market_movement') return `MKT: ${cut}`;
  return `${tool}: ${cut}`;
}

/**
 * Builds a deduplicated, slate-ordered, game-grouped evidence digest for the verifier
 * from all seats' structured `toolEvidenceItems`.
 */
export function buildVerifierEvidence(
  reports: Array<{ toolEvidenceItems?: ToolEvidenceItem[] }>,
  slateSource?: unknown
): string {
  const deduped = new Map<string, ToolEvidenceItem>();
  for (const r of reports || []) {
    const items = Array.isArray(r?.toolEvidenceItems) ? r.toolEvidenceItems : [];
    for (const item of items) {
      if (!item || !item.tool || !item.eventId || !item.summary) continue;
      const key = `${item.tool}::${item.eventId}`;
      if (!deduped.has(key)) {
        deduped.set(key, item);
      }
    }
  }
  if (deduped.size === 0) return '';

  const headers = parseGameHeaders(slateSource);
  const headerById = new Map<string, GameHeader>();
  const orderedIds: string[] = [];
  for (const h of headers) {
    if (h.eventId && !headerById.has(h.eventId)) {
      headerById.set(h.eventId, h);
      orderedIds.push(h.eventId);
    }
  }

  const byEvent = new Map<string, ToolEvidenceItem[]>();
  for (const item of deduped.values()) {
    if (!byEvent.has(item.eventId)) {
      byEvent.set(item.eventId, []);
      if (!headerById.has(item.eventId) && !orderedIds.includes(item.eventId)) {
        orderedIds.push(item.eventId);
      }
    }
    byEvent.get(item.eventId)!.push(item);
  }

  const toolOrder = (t: string): number => {
    if (t === 'get_injury_and_roster_delta') return 0;
    if (t === 'get_matchup_fundamentals') return 1;
    if (t === 'get_market_movement') return 2;
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
