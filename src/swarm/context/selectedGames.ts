import type { GameHeader } from './gameHeaders.ts';

function matchHeadersInText(text: string, headers: GameHeader[], out: Set<string>): void {
  if (!text || !headers.length) return;
  const lower = text.toLowerCase();
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (!h?.eventId) continue;
    const rowRegex = new RegExp(`\\bR${i + 1}\\b`, 'i');
    if (
      text.includes(h.eventId) ||
      rowRegex.test(text) ||
      (h.home && lower.includes(h.home.toLowerCase())) ||
      (h.away && lower.includes(h.away.toLowerCase()))
    ) {
      out.add(h.eventId);
    }
  }
}

function extractFromObject(obj: any, headers: GameHeader[], out: Set<string>): boolean {
  if (!obj || typeof obj !== 'object') return false;
  let foundExplicit = false;

  const directId = obj.event_id || obj.eventId || obj.game_id;
  if (typeof directId === 'string' && directId.trim()) {
    out.add(directId.trim());
    foundExplicit = true;
  }

  const picks = Array.isArray(obj.picks) ? obj.picks : [];
  for (const pk of picks) {
    if (!pk || typeof pk !== 'object') {
      if (typeof pk === 'string') {
        const before = out.size;
        matchHeadersInText(pk, headers, out);
        if (out.size > before) foundExplicit = true;
      }
      continue;
    }
    const pkId = pk.event_id || pk.eventId || pk.game_id;
    if (typeof pkId === 'string' && pkId.trim()) {
      out.add(pkId.trim());
      foundExplicit = true;
    }
    const pkText = [
      pk.row,
      pk.game,
      pk.match,
      pk.side,
      pk.pick,
      pk.selection,
      pk.team,
      pk.reason,
      Array.isArray(pk.reasons) ? pk.reasons[0] : ''
    ]
      .filter(Boolean)
      .map(String)
      .join(' ');
    const before = out.size;
    matchHeadersInText(pkText, headers, out);
    if (out.size > before) foundExplicit = true;
  }

  if (obj.scorecard && typeof obj.scorecard === 'object') {
    const sc = obj.scorecard;
    const scId = sc.event_id || sc.eventId || sc.game_id;
    if (typeof scId === 'string' && scId.trim()) {
      out.add(scId.trim());
      foundExplicit = true;
    }
    const scText = [sc.row, sc.pick, sc.selection, sc.game, sc.match].filter(Boolean).map(String).join(' ');
    const before = out.size;
    matchHeadersInText(scText, headers, out);
    if (out.size > before) foundExplicit = true;
  }

  // Also check single pick-like object fields
  const singleText = [obj.row, obj.game, obj.match, obj.side, obj.pick, obj.selection, obj.team]
    .filter(Boolean)
    .map(String)
    .join(' ');
  if (singleText) {
    const before = out.size;
    matchHeadersInText(singleText, headers, out);
    if (out.size > before) foundExplicit = true;
  }

  if (!foundExplicit) {
    const fallbackText = [
      typeof obj.analysis === 'string' ? obj.analysis : '',
      typeof obj.summary === 'string' ? obj.summary : '',
      Array.isArray(obj.insights) ? obj.insights.join('; ') : ''
    ]
      .filter(Boolean)
      .join(' ');
    matchHeadersInText(fallbackText, headers, out);
  }

  return foundExplicit;
}

/**
 * Deterministically extracts unique selected game event IDs from analyzer/manager proposals
 * mapped against parsed slate headers, excluding unselected slate games.
 */
export function resolveSelectedGameIds(proposals: unknown, headers: GameHeader[] = []): string[] {
  const out = new Set<string>();
  const items = Array.isArray(proposals) ? proposals : [proposals];

  for (const item of items) {
    if (!item) continue;
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          const nested = Array.isArray(parsed) ? parsed : [parsed];
          for (const n of nested) extractFromObject(n, headers, out);
          continue;
        } catch {
          // fall through to text matching
        }
      }
      matchHeadersInText(trimmed, headers, out);
    } else if (typeof item === 'object') {
      extractFromObject(item, headers, out);
    }
  }

  return Array.from(out);
}

/**
 * Filters parsed slate headers strictly to the selected event IDs.
 */
export function filterHeadersByEventIds(headers: GameHeader[], selectedIds: string[]): GameHeader[] {
  if (!selectedIds || selectedIds.length === 0) return headers;
  const set = new Set(selectedIds);
  return headers.filter(h => Boolean(h?.eventId && set.has(h.eventId)));
}
