import type { GameHeader } from './gameHeaders.ts';
import { buildHeaderAliasMap, escapeRegex } from './headerAliases.ts';

function matchHeadersInText(text: string, headers: GameHeader[], out: Set<string>, aliases = false): void {
  if (!text || !headers.length) return;
  const lower = text.toLowerCase();
  const hasExplicitOptions = headers.some(h => Array.isArray(h.options) && h.options.length > 0);
  const aliasByEventId = aliases
    ? new Map(buildHeaderAliasMap(headers).map(entry => [entry.eventId, entry]))
    : null;
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (!h?.eventId) continue;
    const matchedOptionRow = (h.options || []).some(o =>
      Boolean(o.id && o.id.trim()) &&
      new RegExp(`\\b${escapeRegex(o.id.trim())}\\b`, 'i').test(text)
    );
    const fallbackRowMatch = !hasExplicitOptions && new RegExp(`\\bR${i + 1}\\b`, 'i').test(text);
    const aliasEntry = aliasByEventId?.get(h.eventId);
    const matchedAlias = Boolean(
      aliasEntry && (
        aliasEntry.nameAliases.some(alias => new RegExp(`(?<![a-zA-Z0-9])${escapeRegex(alias)}(?![a-zA-Z0-9])`, 'i').test(text)) ||
        aliasEntry.abbrAliases.some(abbr => new RegExp(`(?<![a-zA-Z0-9])${escapeRegex(abbr)}(?![a-zA-Z0-9])`).test(text))
      )
    );
    if (
      text.includes(h.eventId) ||
      matchedOptionRow ||
      fallbackRowMatch ||
      (h.home && lower.includes(h.home.toLowerCase())) ||
      (h.away && lower.includes(h.away.toLowerCase())) ||
      matchedAlias
    ) {
      out.add(h.eventId);
    }
  }
}

function resolveHeaderByRowId(rowRaw: unknown, headers: GameHeader[]): string | undefined {
  if (typeof rowRaw !== 'string' || !headers.length) return undefined;
  const m = rowRaw.trim().match(/\b(R\d+)\b/i);
  if (!m) return undefined;
  const targetRow = m[1].toUpperCase();
  for (const h of headers) {
    if (!h?.eventId) continue;
    const hit = (h.options || []).some(
      (o) => Boolean(o.id && o.id.trim().toUpperCase() === targetRow),
    );
    if (hit) return h.eventId;
  }
  return undefined;
}

function extractFromPickObject(pk: any, headers: GameHeader[], out: Set<string>): boolean {
  if (!pk) return false;
  if (typeof pk === 'string') {
    const rowEv = resolveHeaderByRowId(pk, headers);
    if (rowEv) {
      out.add(rowEv);
      return true;
    }
    const before = out.size;
    matchHeadersInText(pk, headers, out, true);
    return out.size > before;
  }
  if (typeof pk !== 'object') return false;

  let resolvedThisPick = false;
  const pkId = pk.event_id || pk.eventId || pk.game_id;
  if (typeof pkId === 'string' && pkId.trim()) {
    const trimmedId = pkId.trim();
    const matchedHeader = headers.find((h) => h?.eventId === trimmedId);
    out.add(matchedHeader ? matchedHeader.eventId : trimmedId);
    resolvedThisPick = true;
  }

  if (!resolvedThisPick) {
    const rowEv = resolveHeaderByRowId(pk.row || pk.id, headers);
    if (rowEv) {
      out.add(rowEv);
      resolvedThisPick = true;
    }
  }

  if (Array.isArray(pk.legs)) {
    for (const leg of pk.legs) {
      if (extractFromPickObject(leg, headers, out)) {
        resolvedThisPick = true;
      }
    }
  }

  // Only scan non-reason pick identity fields when explicit event_id and R# row did not already resolve the game
  if (!resolvedThisPick) {
    const pkIdentityText = [
      pk.row,
      pk.game,
      pk.match,
      pk.side,
      pk.pick,
      pk.selection,
      pk.team,
    ]
      .filter(Boolean)
      .map(String)
      .join(' ');
    const before = out.size;
    matchHeadersInText(pkIdentityText, headers, out, true);
    if (out.size > before) resolvedThisPick = true;
  }

  return resolvedThisPick;
}

/**
 * Resolves deduplicated event IDs strictly from proposed pick objects in order,
 * without scanning pick rationales (`reason`) or non-pick prose.
 */
export function resolveProposedPickEventIds(
  picks: unknown[],
  headers: GameHeader[] = [],
): string[] {
  const out = new Set<string>();
  if (!Array.isArray(picks)) return [];
  for (const pk of picks) {
    extractFromPickObject(pk, headers, out);
  }
  return Array.from(out);
}

function hasExplicitPickEntries(obj: any): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj.picks) && obj.picks.length > 0) return true;
  if (obj.scorecard && typeof obj.scorecard === 'object' && (obj.scorecard.pick || obj.scorecard.row || obj.scorecard.event_id)) {
    return true;
  }
  return Boolean(obj.event_id || obj.eventId || obj.game_id || obj.row || obj.side || obj.pick || obj.selection);
}

function extractFromObject(
  obj: any,
  headers: GameHeader[],
  out: Set<string>,
  skipProseFallback = false,
): boolean {
  if (!obj || typeof obj !== 'object') return false;
  let foundExplicit = false;

  const directId = obj.event_id || obj.eventId || obj.game_id;
  if (typeof directId === 'string' && directId.trim()) {
    out.add(directId.trim());
    foundExplicit = true;
  }

  const picks = Array.isArray(obj.picks) ? obj.picks : [];
  for (const pk of picks) {
    if (extractFromPickObject(pk, headers, out)) {
      foundExplicit = true;
    }
  }

  if (obj.scorecard && typeof obj.scorecard === 'object') {
    const sc = obj.scorecard;
    const scId = sc.event_id || sc.eventId || sc.game_id;
    if (typeof scId === 'string' && scId.trim()) {
      out.add(scId.trim());
      foundExplicit = true;
    } else {
      const rowEv = resolveHeaderByRowId(sc.row, headers);
      if (rowEv) {
        out.add(rowEv);
        foundExplicit = true;
      } else {
        const scText = [sc.row, sc.pick, sc.selection, sc.game, sc.match].filter(Boolean).map(String).join(' ');
        const before = out.size;
        matchHeadersInText(scText, headers, out, true);
        if (out.size > before) foundExplicit = true;
      }
    }
  }

  // Also check single pick-like object fields when not already resolved by directId or picks[]
  if (!foundExplicit && picks.length === 0) {
    const rowEv = resolveHeaderByRowId(obj.row, headers);
    if (rowEv) {
      out.add(rowEv);
      foundExplicit = true;
    } else {
      const singleText = [obj.row, obj.game, obj.match, obj.side, obj.pick, obj.selection, obj.team]
        .filter(Boolean)
        .map(String)
        .join(' ');
      if (singleText) {
        const before = out.size;
        matchHeadersInText(singleText, headers, out, true);
        if (out.size > before) foundExplicit = true;
      }
    }
  }

  const hasExplicitEmptyPicks = Array.isArray(obj.picks) && obj.picks.length === 0;
  if (!foundExplicit && !hasExplicitEmptyPicks && !skipProseFallback) {
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
  const anyItemHasExplicitPicks = items.some((item) => item && typeof item === 'object' && hasExplicitPickEntries(item));

  for (const item of items) {
    if (!item) continue;
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          const nested = Array.isArray(parsed) ? parsed : [parsed];
          const nestedHasPicks = nested.some((n) => n && typeof n === 'object' && hasExplicitPickEntries(n));
          for (const n of nested) extractFromObject(n, headers, out, anyItemHasExplicitPicks || nestedHasPicks);
          continue;
        } catch {
          // fall through to text matching
        }
      }
      if (!anyItemHasExplicitPicks) {
        matchHeadersInText(trimmed, headers, out);
      }
    } else if (typeof item === 'object') {
      extractFromObject(item, headers, out, anyItemHasExplicitPicks);
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
