import { parseGameHeaders, getEventIdForPick, type GameHeader } from '../context/gameHeaders.ts';
import { ESPN_TEAMS, matchTeamByLabel, normalizeSportHint, type EspnTeamEntry } from './injuryAttribution.ts';

export const MARKET_AND_ROW_RULES = `MARKET AND ROW RULES:
- A moneyline is covered when the tool or board has ml_home or ml_away for that game.
- Do not reject a ML leg solely because a spread is also present.
- Cite the row ID for the exact side you are picking.
- Never assign a row to the opposite team or the opposite side of the line.`;

export const SPREAD_SIDE_RULE = `SPREAD SIDE:
- Read the sign from the row or the tool.
- A negative spread is the favorite. A positive spread is the underdog.
- Do not flip the sign when naming the other team.
- Portland +10.5 is not Portland -10.5.`;

export interface RowOptionEntry {
  rowId: string;
  text: string;
  eventId?: string;
  sport?: string;
  away?: string;
  home?: string;
}

export interface MarketToolRecord {
  tool: string;
  eventId: string;
  summary?: string;
  data?: any;
  markets_covered?: string[];
}

export interface GameMarketCoverage {
  eventId: string;
  marketToolChecked: boolean;
  hasMoneyline: boolean;
  hasSpread: boolean;
  hasTotal: boolean;
}

export interface MarketVetoLegTarget {
  rowId?: string;
  eventId?: string;
  teamLabel?: string;
  teamAliases: string[];
  reason: string;
}

export interface MarketRowAuditResult {
  pass: boolean;
  feedback?: string;
  flags: string[];
  vetoedLegs?: MarketVetoLegTarget[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectStringsFromSource(src: unknown, out: string[]): void {
  if (!src) return;
  if (typeof src === 'string') {
    if (src.trim()) out.push(src);
    return;
  }
  if (Array.isArray(src)) {
    for (const item of src) collectStringsFromSource(item, out);
    return;
  }
  if (typeof src === 'object') {
    const obj = src as Record<string, unknown>;
    for (const key of ['rawBoard', 'board', 'dataSample', 'task', 'content', 'toolResults', 'analystReports']) {
      if (typeof obj[key] === 'string' && String(obj[key]).trim()) {
        out.push(String(obj[key]));
      } else if (Array.isArray(obj[key])) {
        collectStringsFromSource(obj[key], out);
      }
    }
  }
}

/**
 * Builds a map from uppercase Row ID (e.g. "R48") to its option definition from compact-slate
 * headers and any pipe/colon/inline row lines in raw board inputs.
 */
export function extractRowOptions(sources: unknown[], preParsedHeaders?: GameHeader[]): Map<string, RowOptionEntry> {
  const rowMap = new Map<string, RowOptionEntry>();
  const addEntry = (entry: RowOptionEntry) => {
    const key = entry.rowId.trim().toUpperCase();
    if (!/^R\d+$/.test(key) || !entry.text.trim()) return;
    if (!rowMap.has(key)) {
      rowMap.set(key, { ...entry, rowId: key, text: entry.text.trim() });
    }
  };

  for (const h of preParsedHeaders || []) {
    for (const opt of h.options || []) {
      addEntry({
        rowId: opt.id,
        text: opt.text,
        eventId: h.eventId,
        sport: h.sport,
        away: h.away,
        home: h.home
      });
    }
  }

  for (const src of sources) {
    if (!src) continue;
    for (const h of parseGameHeaders(src)) {
      for (const opt of h.options || []) {
        addEntry({
          rowId: opt.id,
          text: opt.text,
          eventId: h.eventId,
          sport: h.sport,
          away: h.away,
          home: h.home
        });
      }
    }
  }

  const rawTexts: string[] = [];
  collectStringsFromSource(sources, rawTexts);

  for (const rawText of rawTexts) {
    const lines = rawText.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      // 1. Any inline "options: R1 ... , R48 ..."
      const optsIdx = line.toLowerCase().indexOf('options:');
      if (optsIdx >= 0) {
        const rawOpts = line.slice(optsIdx + 'options:'.length).trim();
        const optItems = rawOpts.split(/[,;]\s*(?=R\d+\b)/i);
        for (const item of optItems) {
          const m = item.trim().match(/^(R\d+)\s+(.+)$/i);
          if (m) {
            addEntry({ rowId: m[1], text: m[2] });
          }
        }
      }

      // 2. Pipe-delimited table row: "R48 | NHL | Anaheim @ Colorado | Colorado Avalanche -1.5 | +110"
      if (line.includes('|') && /\bR\d+\b/i.test(line)) {
        const cells = line.split('|').map(c => c.trim()).filter(Boolean);
        if (cells.length >= 2 && /^R\d+$/i.test(cells[0])) {
          const rowId = cells[0].toUpperCase();
          const eventId = /^[a-z-]+-\d+$/i.test(cells[1]) ? cells[1] : undefined;
          const body = cells.slice(1).join(' | ');
          addEntry({ rowId, text: body, ...(eventId ? { eventId } : {}) });
          continue;
        }
      }

      // 3. Line beginning with "R48: ..." or "R48 - ..." or "R48 <Side>"
      const lineMatch = line.match(/^(R\d+)\s*[:\-]\s*(.+)$/i);
      if (lineMatch) {
        addEntry({ rowId: lineMatch[1], text: lineMatch[2] });
      }
    }
  }

  return rowMap;
}

export function resolveTeamFromText(
  text: string,
  sportHint?: string,
  contextTeams?: string[]
): { canonical: string; name: string } | undefined {
  if (!text || !text.trim()) return undefined;
  const cleaned = text
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:ml|moneyline|money\s*line|h2h|spread|total|over|under)\b/gi, ' ')
    .replace(/[+-]\d+(?:\.\d+)?/g, ' ')
    .replace(/[^a-zA-Z0-9.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!cleaned) return undefined;

  const sport = normalizeSportHint(sportHint);
  const pool: EspnTeamEntry[] = sport ? ESPN_TEAMS.filter(t => t.sport === sport) : ESPN_TEAMS;

  // Prefer teams belonging to this specific game header first when available
  const cleanCtx = (contextTeams || [])
    .map(t => (typeof t === 'string' ? t.trim() : ''))
    .filter(t => t && !/^(away|home|unknown|tbd)$/i.test(t));

  if (cleanCtx.length > 0) {
    const matchedEntries: Array<{ raw: string; entry?: EspnTeamEntry }> = [];
    for (const ctxTeam of cleanCtx) {
      const lowerCtx = ctxTeam.toLowerCase();
      const entry = pool.find(t =>
        t.name.toLowerCase() === lowerCtx ||
        t.abbr.toLowerCase() === lowerCtx ||
        t.nickname.toLowerCase() === lowerCtx ||
        t.aliases.includes(lowerCtx)
      ) || ESPN_TEAMS.find(t => t.name.toLowerCase() === lowerCtx || t.nickname.toLowerCase() === lowerCtx);
      matchedEntries.push({ raw: ctxTeam, entry });
    }

    // Check full name or nickname matches first so "Los Angeles Clippers" never collides with Lakers
    for (const { raw, entry } of matchedEntries) {
      const lowerRaw = raw.toLowerCase();
      if (new RegExp(`\\b${escapeRegex(lowerRaw)}\\b`, 'i').test(cleaned)) {
        return { canonical: entry ? `${entry.sport}:${entry.abbr}` : lowerRaw, name: entry?.name || raw };
      }
      if (entry && new RegExp(`\\b${escapeRegex(entry.nickname.toLowerCase())}\\b`, 'i').test(cleaned)) {
        return { canonical: `${entry.sport}:${entry.abbr}`, name: entry.name };
      }
    }
    for (const { raw, entry } of matchedEntries) {
      if (!entry) continue;
      for (const alias of entry.aliases) {
        if (alias === entry.city.toLowerCase()) continue; // skip ambiguous city until last
        if (new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i').test(cleaned)) {
          return { canonical: `${entry.sport}:${entry.abbr}`, name: entry.name };
        }
      }
    }
    // Check city only if the other team does not share that city
    for (const { entry } of matchedEntries) {
      if (!entry) continue;
      const cityLower = entry.city.toLowerCase();
      const sharedCity = matchedEntries.filter(m => m.entry?.city.toLowerCase() === cityLower).length > 1;
      if (!sharedCity && new RegExp(`\\b${escapeRegex(cityLower)}\\b`, 'i').test(cleaned)) {
        return { canonical: `${entry.sport}:${entry.abbr}`, name: entry.name };
      }
    }
    // Check college / non-ESPN team school phrases & mascot tokens (e.g. "New Mexico" or "Lobos" for "New Mexico Lobos")
    for (const { raw, entry } of matchedEntries) {
      if (entry) continue;
      const lowerRaw = raw.toLowerCase().trim();
      const words = lowerRaw.split(/\s+/).filter(Boolean);
      const candidates: string[] = [];
      if (words.length >= 2) {
        const schoolPhrase = words.slice(0, words.length - 1).join(' ');
        if (schoolPhrase.length >= 4 && !COLLEGE_ALIAS_STOP_TOKENS.has(schoolPhrase)) {
          candidates.push(schoolPhrase);
        }
        const mascot = words[words.length - 1];
        if (mascot.length >= 4 && !COLLEGE_ALIAS_STOP_TOKENS.has(mascot)) {
          candidates.push(mascot);
        }
      }
      for (const w of words) {
        if (w.length >= 5 && !COLLEGE_ALIAS_STOP_TOKENS.has(w) && !candidates.includes(w)) {
          candidates.push(w);
        }
      }
      for (const cand of candidates) {
        const otherHasCand = matchedEntries.some(
          m => m.raw !== raw && new RegExp(`\\b${escapeRegex(cand)}\\b`, 'i').test(m.raw.toLowerCase())
        );
        if (!otherHasCand && new RegExp(`\\b${escapeRegex(cand)}\\b`, 'i').test(cleaned)) {
          return { canonical: `raw:${lowerRaw}`, name: raw };
        }
      }
    }
  }

  // Global ESPN lookup: full name > nickname > abbr/extra aliases > unique city
  const matchesByFullName = pool.filter(t => new RegExp(`\\b${escapeRegex(t.name.toLowerCase())}\\b`, 'i').test(cleaned));
  if (matchesByFullName.length === 1) {
    return { canonical: `${matchesByFullName[0].sport}:${matchesByFullName[0].abbr}`, name: matchesByFullName[0].name };
  }
  const matchesByNickname = pool.filter(t => new RegExp(`\\b${escapeRegex(t.nickname.toLowerCase())}\\b`, 'i').test(cleaned));
  if (matchesByNickname.length === 1) {
    return { canonical: `${matchesByNickname[0].sport}:${matchesByNickname[0].abbr}`, name: matchesByNickname[0].name };
  }
  const matchesByAbbr = pool.filter(t => new RegExp(`\\b${escapeRegex(t.abbr.toLowerCase())}\\b`, 'i').test(cleaned));
  if (matchesByAbbr.length === 1) {
    return { canonical: `${matchesByAbbr[0].sport}:${matchesByAbbr[0].abbr}`, name: matchesByAbbr[0].name };
  }
  const matchesByCity = pool.filter(t => new RegExp(`\\b${escapeRegex(t.city.toLowerCase())}\\b`, 'i').test(cleaned));
  if (matchesByCity.length === 1) {
    return { canonical: `${matchesByCity[0].sport}:${matchesByCity[0].abbr}`, name: matchesByCity[0].name };
  }
  if (matchesByCity.length > 1 && new Set(matchesByCity.map(m => m.city.toLowerCase())).size === 1) {
    // e.g. "Colorado" across NHL Avalanche / MLB Rockies when sportHint omitted
    const nhlOrFirst = matchesByCity.find(m => m.sport === sport) || matchesByCity[0];
    if (matchesByCity.every(m => m.city.toLowerCase() === nhlOrFirst.city.toLowerCase())) {
      return { canonical: `city:${nhlOrFirst.city.toLowerCase()}`, name: nhlOrFirst.city };
    }
  }

  return undefined;
}

function stripOddsParentheses(text: string): string {
  return text.replace(/\([^)]*\)/g, ' ');
}

function stripNonSpreadParentheses(text: string): string {
  return text.replace(/\(([^)]*)\)/g, (full, inner) => {
    const trimmed = String(inner || '').trim();
    if (!trimmed) return ' '.repeat(full.length);
    if (/^R\d+$/i.test(trimmed)) return ' '.repeat(full.length);
    if (/\b(?:ml|moneyline|money\s*line|h2h|o\/u|over|under|total)\b/i.test(trimmed)) return ' '.repeat(full.length);
    if (/^[+-]\d{3,}(?:\.\d+)?$/.test(trimmed)) return ' '.repeat(full.length);
    return full;
  });
}

function extractSpreadNumber(text: string): number | null {
  if (!text) return null;
  const cleaned = stripNonSpreadParentheses(text);
  // Ignore explicit ML odds like "ML -166" unless a fractional spread is also clearly present
  if (/\b(?:ml|moneyline|money\s*line|h2h)\b/i.test(cleaned) && !/[+-]\d+(?:\.5|\.0)\b/.test(cleaned)) {
    return null;
  }
  const matches = cleaned.match(/(?:^|[\s,:(])([+-]\d+(?:\.\d+)?)(?=$|[\s,);.!])/g);
  if (!matches) return null;
  for (const m of matches) {
    const numMatch = m.match(/([+-]\d+(?:\.\d+)?)/);
    if (!numMatch) continue;
    const val = parseFloat(numMatch[1]);
    // Spreads are < 100 in magnitude; 3-digit numbers (-110, -166, +140) are American odds.
    if (Number.isFinite(val) && Math.abs(val) < 100) {
      return val;
    }
  }
  return null;
}

function extractOverUnder(text: string): { side: 'over' | 'under'; line?: number } | null {
  if (!text) return null;
  const cleaned = stripOddsParentheses(text);
  const m = cleaned.match(/\b(over|under|o|u)\s*(\d+(?:\.\d+)?)?\b/i);
  if (!m) return null;
  const token = m[1].toLowerCase();
  if (token === 'o' || token === 'u') {
    // Require a number after single-letter O/U so we don't match random letters
    if (!m[2]) return null;
  }
  const side: 'over' | 'under' = token.startsWith('o') ? 'over' : 'under';
  const line = m[2] ? parseFloat(m[2]) : undefined;
  return { side, ...(line !== undefined && Number.isFinite(line) ? { line } : {}) };
}

function isMoneylineText(text: string, marketField?: string): boolean {
  const mNorm = String(marketField || '').trim().toLowerCase();
  if (mNorm === 'ml' || mNorm === 'moneyline' || mNorm === 'h2h') return true;
  const cleaned = stripOddsParentheses(text);
  return /\b(?:ml|moneyline|money\s*line|h2h)\b/i.test(cleaned);
}

function formatSigned(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

export function checkRowSideBinding(
  rowId: string,
  pickSideText: string,
  rowEntry: RowOptionEntry,
  marketField?: string
): { valid: boolean; reason?: string; isSignFlipOnly?: boolean; isValueMismatch?: boolean } {
  const side = pickSideText.trim();
  if (!side || !rowEntry?.text) return { valid: true };

  // Strip any leading/trailing row ID token from the side string before comparison
  const sideWithoutRow = side
    .replace(new RegExp(`\\(\\s*${escapeRegex(rowId)}\\s*\\)`, 'gi'), ' ')
    .replace(new RegExp(`^${escapeRegex(rowId)}\\s*[:\\-]?\\s*`, 'i'), '')
    .trim();
  if (!sideWithoutRow) return { valid: true };

  const rowBody = rowEntry.text.trim();
  const contextTeams = [rowEntry.away, rowEntry.home].filter((t): t is string => Boolean(t));

  // 1. Over / Under side & total line comparison
  const rowOU = extractOverUnder(rowBody);
  const pickOU = extractOverUnder(sideWithoutRow);
  if (rowOU && pickOU) {
    if (rowOU.side !== pickOU.side) {
      return {
        valid: false,
        reason: `Row ${rowId} is "${rowBody}", which does not match picked side "${sideWithoutRow}" (Over/Under mismatch).`
      };
    }
    if (rowOU.line !== undefined && pickOU.line !== undefined && rowOU.line !== pickOU.line) {
      return {
        valid: false,
        reason: `Row ${rowId} is "${rowBody}" (${rowOU.line}), which does not match picked line "${sideWithoutRow}" (${pickOU.line}).`
      };
    }
  } else if ((rowOU && !pickOU) || (!rowOU && pickOU)) {
    const rowSpreadCheck = extractSpreadNumber(rowBody);
    const pickSpreadCheck = extractSpreadNumber(sideWithoutRow);
    const rowMlCheck = isMoneylineText(rowBody);
    const pickMlCheck = isMoneylineText(sideWithoutRow, marketField);
    if ((rowOU && (pickSpreadCheck !== null || pickMlCheck)) || (pickOU && (rowSpreadCheck !== null || rowMlCheck))) {
      return {
        valid: false,
        reason: `Row ${rowId} is "${rowBody}", which does not match picked market "${sideWithoutRow}".`
      };
    }
  }

  // 2. Team identity comparison (must not assign row to opposing/other team)
  const rowTeam = resolveTeamFromText(rowBody, rowEntry.sport, contextTeams);
  const pickTeam = resolveTeamFromText(sideWithoutRow, rowEntry.sport, contextTeams);
  if (rowTeam && pickTeam) {
    const sameTeam =
      rowTeam.canonical === pickTeam.canonical ||
      (rowTeam.canonical.startsWith('city:') && pickTeam.name.toLowerCase().includes(rowTeam.name.toLowerCase())) ||
      (pickTeam.canonical.startsWith('city:') && rowTeam.name.toLowerCase().includes(pickTeam.name.toLowerCase()));
    if (!sameTeam) {
      return {
        valid: false,
        reason: `Row ${rowId} is "${rowBody}" (${rowTeam.name}), cannot be assigned to "${sideWithoutRow}" (${pickTeam.name}).`
      };
    }
  }

  // 3. Spread vs Moneyline & Spread Line/Sign comparison
  const rowSpread = extractSpreadNumber(rowBody);
  const pickSpread = extractSpreadNumber(sideWithoutRow);
  const rowIsML = isMoneylineText(rowBody);
  const pickIsML = isMoneylineText(sideWithoutRow, marketField);

  if ((rowIsML && pickSpread !== null) || (rowSpread !== null && pickIsML)) {
    return {
      valid: false,
      reason: `Row ${rowId} is "${rowBody}", which does not match market type of "${sideWithoutRow}".`
    };
  }

  if (rowSpread !== null && pickSpread !== null && rowSpread !== pickSpread) {
    const isSignFlipOnly =
      Math.abs(Math.abs(rowSpread) - Math.abs(pickSpread)) < 0.01 &&
      Math.sign(rowSpread) !== Math.sign(pickSpread);
    return {
      valid: false,
      isSignFlipOnly,
      isValueMismatch: !isSignFlipOnly,
      reason: `Row ${rowId} is "${rowBody}" (${formatSigned(rowSpread)}), does not match "${sideWithoutRow}" (${formatSigned(pickSpread)}).`
    };
  }

  return { valid: true };
}

function hasNonNullValue(val: unknown): boolean {
  return val !== null && val !== undefined && val !== '' && val !== 'N/A';
}

function checkMarketDataHasML(data: any): boolean {
  if (!data || typeof data !== 'object') return false;
  if (
    hasNonNullValue(data.ml_home) ||
    hasNonNullValue(data.ml_away) ||
    hasNonNullValue(data.opening_ml_home) ||
    hasNonNullValue(data.opening_ml_away) ||
    hasNonNullValue(data.current_ml_home) ||
    hasNonNullValue(data.current_ml_away) ||
    hasNonNullValue(data.latest?.ml_home) ||
    hasNonNullValue(data.latest?.ml_away) ||
    hasNonNullValue(data.opening?.ml_home) ||
    hasNonNullValue(data.opening?.ml_away)
  ) {
    return true;
  }
  if (Array.isArray(data.line_snapshots)) {
    return data.line_snapshots.some((s: any) => s && (hasNonNullValue(s.ml_home) || hasNonNullValue(s.ml_away)));
  }
  return false;
}

function checkMarketDataHasSpread(data: any): boolean {
  if (!data || typeof data !== 'object') return false;
  if (
    hasNonNullValue(data.spread) ||
    hasNonNullValue(data.spread_home) ||
    hasNonNullValue(data.spread_away) ||
    hasNonNullValue(data.opening_spread) ||
    hasNonNullValue(data.current_spread) ||
    hasNonNullValue(data.latest?.spread) ||
    hasNonNullValue(data.latest?.spread_home) ||
    hasNonNullValue(data.opening?.spread) ||
    hasNonNullValue(data.opening?.spread_home)
  ) {
    return true;
  }
  if (Array.isArray(data.line_snapshots)) {
    return data.line_snapshots.some((s: any) => s && (hasNonNullValue(s.spread) || hasNonNullValue(s.spread_home)));
  }
  return false;
}

function checkMarketDataHasTotal(data: any): boolean {
  if (!data || typeof data !== 'object') return false;
  if (
    hasNonNullValue(data.total) ||
    hasNonNullValue(data.opening_total) ||
    hasNonNullValue(data.current_total) ||
    hasNonNullValue(data.latest?.total) ||
    hasNonNullValue(data.opening?.total)
  ) {
    return true;
  }
  if (Array.isArray(data.line_snapshots)) {
    return data.line_snapshots.some((s: any) => s && hasNonNullValue(s.total));
  }
  return false;
}

function summaryTextHasMoneyline(text: string): boolean {
  if (!text) return false;
  if (/ml_home\s*(?:=|:)?\s*[+-]?\d+|ml_away\s*(?:=|:)?\s*[+-]?\d+|\bML:\s*(?!N\/A\b)[^\n|]*(?:[+-]\d{2,4}|\bml_home\b|\bml_away\b)/i.test(text)) {
    return true;
  }
  if (/\b(?:ml_home|ml_away)\b/i.test(text) && !/\b(?:ml_home|ml_away)\s*(?:=|:)?\s*(?:null|N\/A|none)\b/i.test(text)) {
    return true;
  }
  if (/\b(?:moneyline|h2h)\b/i.test(text) && !/\b(?:no|missing|without)\s+(?:moneyline|ml)\b/i.test(text)) {
    return true;
  }
  if (/\[MARKET MOVEMENT:[^|\]]+\|\s*(?:ml|moneyline|h2h)\b/i.test(text) && !/N\/A/i.test(text)) {
    return true;
  }
  if (/\b(?:ML|spread\/ml_home)\s+confirmed\b/i.test(text)) {
    return true;
  }
  return false;
}

/**
 * Computes per-game market coverage from structured tool records, tool evidence text, and board headers.
 */
export function extractMarketCoverageByGame(
  toolEvidenceText: string,
  boardText: string,
  headers: GameHeader[],
  toolRecords?: MarketToolRecord[]
): Map<string, GameMarketCoverage> {
  const coverage = new Map<string, GameMarketCoverage>();
  const ensure = (eventId: string): GameMarketCoverage => {
    if (!coverage.has(eventId)) {
      coverage.set(eventId, {
        eventId,
        marketToolChecked: false,
        hasMoneyline: false,
        hasSpread: false,
        hasTotal: false
      });
    }
    return coverage.get(eventId)!;
  };

  // 1. From GameHeader options (board odds)
  for (const h of headers || []) {
    if (!h?.eventId) continue;
    const cov = ensure(h.eventId);
    for (const opt of h.options || []) {
      const txt = opt.text || '';
      if (isMoneylineText(txt)) cov.hasMoneyline = true;
      if (extractSpreadNumber(txt) !== null) cov.hasSpread = true;
      if (extractOverUnder(txt) !== null) cov.hasTotal = true;
    }
  }

  // 2. From structured market tool records (highest authority)
  for (const rec of toolRecords || []) {
    if (!rec || rec.tool !== 'get_market_movement' || !rec.eventId) continue;
    const cov = ensure(rec.eventId);
    cov.marketToolChecked = true;
    if (rec.markets_covered?.includes('ml') || checkMarketDataHasML(rec.data)) cov.hasMoneyline = true;
    if (rec.markets_covered?.includes('spread') || checkMarketDataHasSpread(rec.data)) cov.hasSpread = true;
    if (rec.markets_covered?.includes('total') || checkMarketDataHasTotal(rec.data)) cov.hasTotal = true;
    if (rec.summary) {
      if (summaryTextHasMoneyline(rec.summary)) cov.hasMoneyline = true;
      if (/\bspread\b|home\s+[^\n]+\s+[+-]\d+(?:\.\d+)?\s*\/\s*away\b/i.test(rec.summary)) cov.hasSpread = true;
      if (/\bTotal:\s*(?!N\/A\b)\d+(?:\.\d+)?/i.test(rec.summary)) cov.hasTotal = true;
    }
  }

  // 3. From compacted tool evidence text blocks ("EVENT <id>..." or "[MARKET MOVEMENT: <id>...]")
  if (toolEvidenceText) {
    const blocks = toolEvidenceText.split(/(?=^EVENT\s+|^\[MARKET MOVEMENT:)/m);
    for (const block of blocks) {
      const evMatch = block.match(/^(?:EVENT\s+|\[MARKET MOVEMENT:\s*)([^\s|\]]+)/m);
      if (!evMatch || !evMatch[1]) continue;
      const eventId = evMatch[1].trim();
      if (!/\b(?:MKT:|\[MARKET MOVEMENT:|get_market_movement)\b/i.test(block)) continue;
      const cov = ensure(eventId);
      cov.marketToolChecked = true;
      if (summaryTextHasMoneyline(block)) cov.hasMoneyline = true;
      if (/home\s+[^\n]+\s+[+-]\d+(?:\.\d+)?\s*\/\s*away\b|\bspread\b/i.test(block)) cov.hasSpread = true;
      if (/\bTotal:\s*(?!N\/A\b)\d+(?:\.\d+)?|\btotal\b/i.test(block)) cov.hasTotal = true;
    }
  }

  // 4. From raw board lines mentioning ml_home / ml_away for a known eventId
  if (boardText) {
    const lines = boardText.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      for (const h of headers || []) {
        if (!h?.eventId) continue;
        if (line.includes(h.eventId) || (h.home && line.toLowerCase().includes(h.home.toLowerCase()))) {
          if (/ml_home\s*(?:=|:)?\s*[+-]?\d+|ml_away\s*(?:=|:)?\s*[+-]?\d+/i.test(line)) {
            ensure(h.eventId).hasMoneyline = true;
          }
        }
      }
    }
  }

  return coverage;
}

interface PickLikeInfo {
  pick: any;
  rowId?: string;
  sideText: string;
  marketField?: string;
  eventId?: string;
}

function extractProposalPicks(proposal: any, headers: GameHeader[], rowMap: Map<string, RowOptionEntry>): PickLikeInfo[] {
  const results: PickLikeInfo[] = [];
  if (!proposal || typeof proposal !== 'object') return results;

  const pushPickObj = (pk: any) => {
    if (!pk || typeof pk !== 'object') return;
    let rowId = typeof pk.row === 'string' && /^R\d+$/i.test(pk.row.trim())
      ? pk.row.trim().toUpperCase()
      : (typeof pk.id === 'string' && /^R\d+$/i.test(pk.id.trim()) ? pk.id.trim().toUpperCase() : undefined);

    const sideText = [pk.side, pk.pick, pk.selection, pk.team, pk.note]
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .join(' ')
      .trim();

    if (!rowId && sideText) {
      const m = sideText.match(/\b(R\d+)\b/i);
      if (m) rowId = m[1].toUpperCase();
    }

    let eventId = getEventIdForPick(pk, headers);
    if (!eventId && rowId && rowMap.get(rowId)?.eventId) {
      eventId = rowMap.get(rowId)!.eventId;
    }

    results.push({
      pick: pk,
      rowId,
      sideText: sideText || (typeof pk.reason === 'string' ? pk.reason : ''),
      marketField: typeof pk.market === 'string' ? pk.market : undefined,
      eventId
    });
  };

  if (Array.isArray(proposal.picks)) {
    for (const pk of proposal.picks) {
      if (typeof pk === 'string') {
        const m = pk.match(/\b(R\d+)\b/i);
        results.push({
          pick: pk,
          rowId: m ? m[1].toUpperCase() : undefined,
          sideText: pk,
          eventId: getEventIdForPick(pk, headers) || (m ? rowMap.get(m[1].toUpperCase())?.eventId : undefined)
        });
      } else {
        pushPickObj(pk);
      }
    }
  }

  if (proposal.scorecard && Array.isArray(proposal.scorecard.picks)) {
    for (const pk of proposal.scorecard.picks) pushPickObj(pk);
  }
  if (Array.isArray(proposal.scorecards)) {
    for (const sc of proposal.scorecards) {
      if (sc && Array.isArray(sc.picks)) {
        for (const pk of sc.picks) pushPickObj(pk);
      }
    }
  }

  // Also check explicit inline citations like "Anaheim Ducks +1.5 (R48)" or "R48: Anaheim Ducks +1.5" in text fields
  const textFields = [
    typeof proposal.summary === 'string' ? proposal.summary : '',
    typeof proposal.analysis === 'string' ? proposal.analysis : '',
    ...(Array.isArray(proposal.insights) ? proposal.insights.filter((x: any) => typeof x === 'string') : [])
  ].filter(Boolean);

  for (const text of textFields) {
    // Pattern A: "<Team/Side> (R48)"
    const parenRegex = /([^.;,\n|]{3,65}?)\(\s*(R\d+)\s*\)/gi;
    let m: RegExpExecArray | null;
    while ((m = parenRegex.exec(text)) !== null) {
      const phrase = m[1].trim();
      const rowId = m[2].toUpperCase();
      if (rowMap.has(rowId) && !results.some(r => r.rowId === rowId && r.sideText.includes(phrase))) {
        results.push({
          pick: phrase,
          rowId,
          sideText: phrase,
          eventId: rowMap.get(rowId)?.eventId
        });
      }
    }
    // Pattern B: "R48: <Team/Side>" or "R48 - <Team/Side>"
    const prefixRegex = /\b(R\d+)\s*[:\-]\s*([^.;,\n|]{3,65})/gi;
    while ((m = prefixRegex.exec(text)) !== null) {
      const rowId = m[1].toUpperCase();
      const phrase = m[2].trim();
      if (rowMap.has(rowId) && !results.some(r => r.rowId === rowId && r.sideText.includes(phrase))) {
        results.push({
          pick: phrase,
          rowId,
          sideText: phrase,
          eventId: rowMap.get(rowId)?.eventId
        });
      }
    }
  }

  return results;
}

export interface AuthoritativeTeamSpread {
  canonical: string;
  teamName: string;
  aliases: string[];
  abbr?: string;
  spread: number;
  role: 'favorite' | 'underdog' | 'pickem';
  eventId?: string;
  venue?: 'home' | 'away';
  source: 'slate' | 'tool';
}

const STOPWORD_ALIASES = new Set(['as', 'no', 'was', 'in', 'or', 'at', 'by', 'to', 'on', 'of', 'la', 'ny', 'sa', 'sd', 'sf', 'gb', 'kc', 'lv', 'ne', 'tb']);
const COLLEGE_ALIAS_STOP_TOKENS = new Set([
  'state', 'tech', 'university', 'college', 'north', 'south', 'east', 'west',
  'central', 'western', 'eastern', 'northern', 'southern', 'golden', 'blue',
  'red', 'green', 'black', 'white', 'crimson', 'city', 'team', 'new', 'san',
  'saint', 'santa', 'los', 'las', 'el', 'la', 'de', 'of', 'the', 'at'
]);

function buildSafeTeamAliases(
  rawTeamLabel: string,
  sportHint: string | undefined,
  sharedCityCollision: Set<string>,
  sharedSlateCities: Set<string>,
  sharedCollegeTokens?: Set<string>
): { canonical: string; teamName: string; aliases: string[]; abbr?: string } {
  const entry = matchTeamByLabel(rawTeamLabel, sportHint);
  const canonical = entry ? `${entry.sport}:${entry.abbr}` : `raw:${rawTeamLabel.toLowerCase().trim()}`;
  const teamName = entry?.name || rawTeamLabel.trim();
  const aliasSet = new Set<string>();

  if (teamName) aliasSet.add(teamName.toLowerCase());
  if (rawTeamLabel.trim()) aliasSet.add(rawTeamLabel.toLowerCase().trim());
  if (entry) {
    if (entry.nickname) aliasSet.add(entry.nickname.toLowerCase());
    const cityLower = entry.city.toLowerCase();
    if (cityLower && !sharedCityCollision.has(cityLower) && !sharedSlateCities.has(cityLower)) {
      aliasSet.add(cityLower);
    }
    for (const a of entry.aliases) {
      const al = a.toLowerCase().trim();
      if (!al || al === entry.abbr.toLowerCase() || al.length < 3) continue;
      if (STOPWORD_ALIASES.has(al)) continue;
      if (al === cityLower && (sharedCityCollision.has(cityLower) || sharedSlateCities.has(cityLower))) continue;
      aliasSet.add(al);
    }
  } else {
    // College / non-ESPN teams (e.g. "New Mexico Lobos" -> "new mexico", "lobos")
    const lowerRaw = rawTeamLabel.toLowerCase().trim();
    const words = lowerRaw.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      const schoolPhrase = words.slice(0, words.length - 1).join(' ');
      if (
        schoolPhrase.length >= 4 &&
        !COLLEGE_ALIAS_STOP_TOKENS.has(schoolPhrase) &&
        !sharedCityCollision.has(schoolPhrase) &&
        !sharedSlateCities.has(schoolPhrase) &&
        !sharedCollegeTokens?.has(schoolPhrase)
      ) {
        aliasSet.add(schoolPhrase);
      }
      const mascot = words[words.length - 1];
      if (
        mascot.length >= 4 &&
        !COLLEGE_ALIAS_STOP_TOKENS.has(mascot) &&
        !STOPWORD_ALIASES.has(mascot) &&
        !sharedCollegeTokens?.has(mascot)
      ) {
        aliasSet.add(mascot);
      }
    }
  }

  return {
    canonical,
    teamName,
    aliases: Array.from(aliasSet).sort((a, b) => b.length - a.length),
    ...(entry?.abbr ? { abbr: entry.abbr } : {})
  };
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function extractBoardText(boardSource: unknown): string {
  if (typeof boardSource === 'string') return boardSource;
  if (boardSource && typeof boardSource === 'object') {
    const b = boardSource as any;
    return [b.rawBoard, b.board, b.dataSample, b.task, b.content].filter(Boolean).join('\n');
  }
  return '';
}

function resolveBareSpreadWithMl(
  bare: number | null,
  mlH: number | null,
  mlA: number | null
): { home: number; away: number } | null {
  if (bare === null || !Number.isFinite(bare) || Math.abs(bare) >= 100 || bare === 0) return null;
  if (mlH !== null && mlA !== null && mlH !== mlA) {
    const homeIsFav = mlH < mlA;
    if ((homeIsFav && bare > 0) || (!homeIsFav && bare < 0)) {
      return { home: -bare, away: bare };
    }
    return { home: bare, away: -bare };
  }
  if (mlH !== null) {
    if (mlH <= -135) return bare > 0 ? { home: -bare, away: bare } : { home: bare, away: -bare };
    if (mlH >= 135) return bare < 0 ? { home: -bare, away: bare } : { home: bare, away: -bare };
  }
  if (mlA !== null) {
    if (mlA <= -135) return bare < 0 ? { home: -bare, away: bare } : { home: bare, away: -bare };
    if (mlA >= 135) return bare > 0 ? { home: -bare, away: bare } : { home: bare, away: -bare };
  }
  return null;
}

function extractSpreadsFromToolSummary(
  text: string,
  awayLabel: string,
  homeLabel: string
): { home?: number; away?: number } {
  if (!text) return {};
  const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const awayEntry = matchTeamByLabel(awayLabel);
  const homeEntry = matchTeamByLabel(homeLabel);
  const awayNames = Array.from(new Set([awayLabel, awayEntry?.name, awayEntry?.abbr, awayEntry?.nickname, awayEntry?.city].filter((x): x is string => Boolean(x))));
  const homeNames = Array.from(new Set([homeLabel, homeEntry?.name, homeEntry?.abbr, homeEntry?.nickname, homeEntry?.city].filter((x): x is string => Boolean(x))));

  // Prefer Current:/Line: over Open: if multiple appear
  const currentLineMatch = text.match(/(?:Current|Line):\s*([^\n]+)/i);
  const targetLine = currentLineMatch ? currentLineMatch[1] : text;

  const pairMatch = targetLine.match(/home\s+([^\n/]+?)\s+([+-]\d+(?:\.\d+)?)\s*\/\s*away\s+([^\n|]+?)\s+([+-]\d+(?:\.\d+)?)/i);
  if (pairMatch) {
    const hVal = parseFloat(pairMatch[2]);
    const aVal = parseFloat(pairMatch[4]);
    if (Number.isFinite(hVal) && Number.isFinite(aVal) && Math.abs(hVal) < 100 && Math.abs(aVal) < 100) {
      return { home: hVal, away: aVal };
    }
  }

  // Fallback: check gameContext.ts odds format ("spread=-10.5/10.5") preferring (curr)
  const currOddsMatch = text.match(/\(curr\)[^|\n]*?\bspread=([+-]?\d+(?:\.\d+)?)\/([+-]?\d+(?:\.\d+)?)/i)
    || text.match(/\bspread=([+-]?\d+(?:\.\d+)?)\/([+-]?\d+(?:\.\d+)?)/i);
  if (currOddsMatch) {
    const hVal = parseFloat(currOddsMatch[1]);
    const aVal = parseFloat(currOddsMatch[2]);
    if (Number.isFinite(hVal) && Number.isFinite(aVal) && Math.abs(hVal) < 100 && Math.abs(aVal) < 100) {
      return { home: hVal, away: aVal };
    }
  }

  // Fallback: check supabase.ts line_snapshots format ("Spread=+10.5, Total=228.5, ML(H/A)=-500/+380")
  const snapLineMatch = text.match(/\bSpread=([+-]?\d+(?:\.\d+)?)\b[^\n]*?\bML\(H\/A\)=([+-]?\d+|N\/A)\/([+-]?\d+|N\/A)/i);
  if (snapLineMatch) {
    const bare = parseFloat(snapLineMatch[1]);
    const mlH = snapLineMatch[2].toUpperCase() === 'N/A' ? null : parseFloat(snapLineMatch[2]);
    const mlA = snapLineMatch[3].toUpperCase() === 'N/A' ? null : parseFloat(snapLineMatch[3]);
    const resolved = resolveBareSpreadWithMl(bare, mlH, mlA);
    if (resolved) return resolved;
  }

  // Fallback: check if bare spread (signed or unsigned, e.g. "spread 7.5, ml_away -290") + ml_home / ml_away appear together in summary
  const bareMatch = targetLine.match(/\bspread\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)\b/i)
    || text.match(/\bspread\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)\b/i);
  if (bareMatch) {
    const bare = parseFloat(bareMatch[1]);
    const mlHomeMatch = text.match(/\bml_home\b[^\n+-]*?([+-]\d{3,4})/i);
    const mlAwayMatch = text.match(/\bml_away\b[^\n+-]*?([+-]\d{3,4})/i);
    const mlH = mlHomeMatch ? parseFloat(mlHomeMatch[1]) : null;
    const mlA = mlAwayMatch ? parseFloat(mlAwayMatch[1]) : null;
    const resolved = resolveBareSpreadWithMl(bare, mlH, mlA);
    if (resolved) return resolved;
  }

  // Fallback: match explicit "<HomeName> <+/-X>" / "<AwayName> <+/-Y>"
  let hOut: number | undefined;
  let aOut: number | undefined;
  for (const hName of homeNames) {
    const m = targetLine.match(new RegExp(`\\b${escapeRx(hName)}\\s+([+-]\\d+(?:\\.\\d+)?)\\b`, 'i'));
    if (m) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v) && Math.abs(v) < 100) {
        hOut = v;
        break;
      }
    }
  }
  for (const aName of awayNames) {
    const m = targetLine.match(new RegExp(`\\b${escapeRx(aName)}\\s+([+-]\\d+(?:\\.\\d+)?)\\b`, 'i'));
    if (m) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v) && Math.abs(v) < 100) {
        aOut = v;
        break;
      }
    }
  }
  return {
    ...(hOut !== undefined ? { home: hOut } : {}),
    ...(aOut !== undefined ? { away: aOut } : {})
  };
}

export function extractAuthoritativeTeamSpreads(
  headers: GameHeader[],
  rowMap: Map<string, RowOptionEntry>,
  toolEvidenceText?: string,
  toolRecords?: MarketToolRecord[],
  boardText?: string
): Map<string, AuthoritativeTeamSpread> {
  const spreadMap = new Map<string, AuthoritativeTeamSpread>();

  // Detect any cities or college school/mascot tokens shared across DIFFERENT teams in the current slate
  const cityToCanonicals = new Map<string, Set<string>>();
  const collegeTokenToCanonicals = new Map<string, Set<string>>();
  for (const h of headers || []) {
    for (const rawTeam of [h.away, h.home]) {
      const e = matchTeamByLabel(rawTeam, h.sport);
      if (e?.city) {
        const cl = e.city.toLowerCase();
        if (!cityToCanonicals.has(cl)) cityToCanonicals.set(cl, new Set());
        cityToCanonicals.get(cl)!.add(`${e.sport}:${e.abbr}`);
      } else if (rawTeam && rawTeam.trim()) {
        const lowerRaw = rawTeam.toLowerCase().trim();
        const canonicalKey = `raw:${lowerRaw}`;
        const words = lowerRaw.split(/\s+/).filter(Boolean);
        if (words.length >= 2) {
          for (const tok of [words.slice(0, words.length - 1).join(' '), words[words.length - 1]]) {
            if (!tok || tok.length < 4 || COLLEGE_ALIAS_STOP_TOKENS.has(tok)) continue;
            if (!collegeTokenToCanonicals.has(tok)) collegeTokenToCanonicals.set(tok, new Set());
            collegeTokenToCanonicals.get(tok)!.add(canonicalKey);
          }
        }
      }
    }
  }
  const sharedSlateCities = new Set<string>();
  for (const [city, set] of cityToCanonicals.entries()) {
    if (set.size > 1) sharedSlateCities.add(city);
  }
  const sharedCollegeTokens = new Set<string>();
  for (const [tok, set] of collegeTokenToCanonicals.entries()) {
    if (set.size > 1) sharedCollegeTokens.add(tok);
  }

  for (const h of headers || []) {
    const contextTeams = [h.away, h.home].filter((t): t is string => Boolean(t));
    const awayEntry = matchTeamByLabel(h.away, h.sport);
    const homeEntry = matchTeamByLabel(h.home, h.sport);
    const sharedInGame = new Set<string>();
    if (awayEntry?.city && homeEntry?.city && awayEntry.city.toLowerCase() === homeEntry.city.toLowerCase()) {
      sharedInGame.add(awayEntry.city.toLowerCase());
    }

    const awayProfile = buildSafeTeamAliases(h.away, h.sport, sharedInGame, sharedSlateCities, sharedCollegeTokens);
    const homeProfile = buildSafeTeamAliases(h.home, h.sport, sharedInGame, sharedSlateCities, sharedCollegeTokens);

    let awaySpread: number | undefined;
    let homeSpread: number | undefined;
    let source: 'slate' | 'tool' = 'slate';

    // 1. Check slate options on header and rowMap
    const candidateOptions: Array<{ text: string }> = [
      ...(h.options || []),
      ...Array.from(rowMap.values()).filter(r => r.eventId === h.eventId && !(h.options || []).some(o => o.id.toUpperCase() === r.rowId))
    ];
    for (const opt of candidateOptions) {
      if (!opt?.text || isMoneylineText(opt.text) || extractOverUnder(opt.text)) continue;
      const sp = extractSpreadNumber(opt.text);
      if (sp === null) continue;
      const resolved = resolveTeamFromText(opt.text, h.sport, contextTeams);
      if (!resolved) continue;
      if (resolved.canonical === awayProfile.canonical || resolved.name.toLowerCase() === awayProfile.teamName.toLowerCase()) {
        awaySpread = sp;
      } else if (resolved.canonical === homeProfile.canonical || resolved.name.toLowerCase() === homeProfile.teamName.toLowerCase()) {
        homeSpread = sp;
      }
    }

    if (awaySpread !== undefined && homeSpread === undefined) {
      homeSpread = awaySpread === 0 ? 0 : -awaySpread;
    } else if (homeSpread !== undefined && awaySpread === undefined) {
      awaySpread = homeSpread === 0 ? 0 : -homeSpread;
    }

    // 2. Supplement from structured market tool records if slate didn't include spread rows
    if (awaySpread === undefined || homeSpread === undefined) {
      const rec = (toolRecords || []).find(r => r && r.tool === 'get_market_movement' && r.eventId === h.eventId);
      if (rec) {
        const d = rec.data || {};
        const latest = typeof d.latest === 'object' && d.latest !== null ? d.latest : {};
        const opening = typeof d.opening === 'object' && d.opening !== null ? d.opening : {};
        const snaps = Array.isArray(d.line_snapshots) ? d.line_snapshots : [];
        const lastSnap = snaps.length > 0 ? snaps[snaps.length - 1] || {} : {};
        const firstSnap = snaps.length > 0 ? snaps[0] || {} : {};

        const expHome = toFiniteNumber(latest.spread_home ?? d.current_spread_home ?? lastSnap.spread_home ?? opening.spread_home ?? d.opening_spread_home ?? firstSnap.spread_home);
        const expAway = toFiniteNumber(latest.spread_away ?? d.current_spread_away ?? lastSnap.spread_away ?? opening.spread_away ?? d.opening_spread_away ?? firstSnap.spread_away);
        if (expHome !== null || expAway !== null) {
          source = 'tool';
          homeSpread = expHome !== null ? expHome : (expAway! === 0 ? 0 : -expAway!);
          awaySpread = expAway !== null ? expAway : (homeSpread === 0 ? 0 : -homeSpread);
        } else {
          const parsedSummary = extractSpreadsFromToolSummary(rec.summary || '', h.away, h.home);
          if (parsedSummary.home !== undefined || parsedSummary.away !== undefined) {
            source = 'tool';
            homeSpread = parsedSummary.home ?? (parsedSummary.away! === 0 ? 0 : -parsedSummary.away!);
            awaySpread = parsedSummary.away ?? (homeSpread === 0 ? 0 : -homeSpread);
          } else {
            const bare = toFiniteNumber(latest.spread ?? d.current_spread ?? lastSnap.spread ?? opening.spread ?? d.opening_spread ?? firstSnap.spread);
            const mlH = toFiniteNumber(latest.ml_home ?? d.current_ml_home ?? d.ml_home ?? lastSnap.ml_home ?? opening.ml_home);
            const mlA = toFiniteNumber(latest.ml_away ?? d.current_ml_away ?? d.ml_away ?? lastSnap.ml_away ?? opening.ml_away);
            const resolvedBare = resolveBareSpreadWithMl(bare, mlH, mlA);
            if (resolvedBare) {
              source = 'tool';
              homeSpread = resolvedBare.home;
              awaySpread = resolvedBare.away;
            }
          }
        }
      }
    }

    // 3. Supplement from toolEvidenceText if still unresolved
    if ((awaySpread === undefined || homeSpread === undefined) && toolEvidenceText) {
      const blocks = toolEvidenceText.split(/(?=^EVENT\s+|^\[MARKET MOVEMENT:)/m);
      const matchingBlock = blocks.find(b => b.includes(h.eventId)) || '';
      if (matchingBlock) {
        const parsedBlock = extractSpreadsFromToolSummary(matchingBlock, h.away, h.home);
        if (parsedBlock.home !== undefined || parsedBlock.away !== undefined) {
          source = 'tool';
          homeSpread = parsedBlock.home ?? (parsedBlock.away! === 0 ? 0 : -parsedBlock.away!);
          awaySpread = parsedBlock.away ?? (homeSpread === 0 ? 0 : -homeSpread);
        }
      }
    }

    // 4. Supplement from boardText snapshot lines/blocks when still unresolved
    if ((awaySpread === undefined || homeSpread === undefined) && boardText) {
      const boardBlocks = boardText.split(/(?=^EVENT\s+|^\s*•?\s*\[?event_id=)/m);
      const matchedBlocks = boardBlocks.filter(b => b.includes(h.eventId)).join('\n');
      const matchedLines = matchedBlocks || boardText.split(/\r?\n/).filter(l => l.includes(h.eventId)).join('\n');
      if (matchedLines) {
        const parsedBoard = extractSpreadsFromToolSummary(matchedLines, h.away, h.home);
        if (parsedBoard.home !== undefined || parsedBoard.away !== undefined) {
          source = 'slate';
          homeSpread = parsedBoard.home ?? (parsedBoard.away! === 0 ? 0 : -parsedBoard.away!);
          awaySpread = parsedBoard.away ?? (homeSpread === 0 ? 0 : -homeSpread);
        }
      }
    }

    if (awaySpread !== undefined) {
      spreadMap.set(awayProfile.canonical, {
        ...awayProfile,
        spread: awaySpread,
        role: awaySpread < 0 ? 'favorite' : (awaySpread > 0 ? 'underdog' : 'pickem'),
        eventId: h.eventId,
        venue: 'away',
        source
      });
    }
    if (homeSpread !== undefined) {
      spreadMap.set(homeProfile.canonical, {
        ...homeProfile,
        spread: homeSpread,
        role: homeSpread < 0 ? 'favorite' : (homeSpread > 0 ? 'underdog' : 'pickem'),
        eventId: h.eventId,
        venue: 'home',
        source
      });
    }
  }

  return spreadMap;
}

interface ClauseTeamHit {
  start: number;
  end: number;
  matchedText: string;
  entry: AuthoritativeTeamSpread;
}

function findTeamHitsInClause(clause: string, spreadMap: Map<string, AuthoritativeTeamSpread>): ClauseTeamHit[] {
  const hits: ClauseTeamHit[] = [];
  for (const entry of spreadMap.values()) {
    for (const alias of entry.aliases) {
      const rx = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'gi');
      let m: RegExpExecArray | null;
      while ((m = rx.exec(clause)) !== null) {
        hits.push({ start: m.index, end: m.index + m[0].length, matchedText: m[0], entry });
      }
    }
    if (entry.abbr && entry.abbr.length >= 2) {
      const abbrRx = new RegExp(`\\b${escapeRegex(entry.abbr.toUpperCase())}\\b`, 'g');
      let m: RegExpExecArray | null;
      while ((m = abbrRx.exec(clause)) !== null) {
        hits.push({ start: m.index, end: m.index + m[0].length, matchedText: m[0], entry });
      }
    }
  }
  hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const deduped: ClauseTeamHit[] = [];
  for (const h of hits) {
    const overlaps = deduped.some(prev => !(h.end <= prev.start || h.start >= prev.end));
    if (!overlaps) deduped.push(h);
  }
  return deduped;
}

interface SpreadSideViolation {
  reason: string;
  kind: 'sign_flip' | 'value_mismatch' | 'role_flip';
  entry: AuthoritativeTeamSpread;
  wrongNumberRaw?: string;
  wrongNumberStart?: number;
  wrongNumberEnd?: number;
}

const DIRECT_STAT_PREFIX_RX = /\b(?:net\s*rating|nrtg|ortg|drtg|point\s*diff(?:erential)?|goal\s*diff(?:erential)?|run\s*diff(?:erential)?|diff(?:erential)?|xgf|xg|ppg|gpg|era|pace|delta|roi|ev|kelly|(?:moved|move|steam(?:ed)?|swing)\s+(?:by|of)|margin\s+of|edge\s+of)\s*[:=of\s]*$/i;
const DIRECT_STAT_SUFFIX_RX = /^\s*(?:%|(?:spread|line|total|pts?|points?)\s+(?:move|delta|swing|diff|margin|shift)\b|(?:(?:l\d+|last\s*\d+)\s+)?(?:net\s*)?margin\b|units?\b|u\b|net\s*rating\b|nrtg\b|ortg\b|drtg\b|diff(?:erential)?\b|delta\b|swing\b|ppg\b|gpg\b|goals?\b|runs?\b|yards?\b|era\b|roi\b|ev\b)/i;

function findSpreadSideViolationInClause(
  clause: string,
  spreadMap: Map<string, AuthoritativeTeamSpread>
): SpreadSideViolation | null {
  if (!clause || !clause.trim() || spreadMap.size === 0) return null;
  const teamHits = findTeamHitsInClause(clause, spreadMap);
  if (teamHits.length === 0) return null;

  // 1. Check explicit signed spread numbers paired with a team in the clause
  const cleanedForNum = stripNonSpreadParentheses(clause);
  const numRx = /(?:^|[\s,:(\["'/])([+-]\d+(?:\.\d+)?)(?=$|[\s,);!?:\]"'/—–]|\.(?!\d))/g;
  let nm: RegExpExecArray | null;
  while ((nm = numRx.exec(cleanedForNum)) !== null) {
    const numStr = nm[1];
    const numOffset = nm.index + nm[0].indexOf(numStr);
    const val = parseFloat(numStr);
    if (!Number.isFinite(val) || Math.abs(val) >= 100 || val === 0) continue;
    // Sports spreads/pucklines/runlines only come in whole or half-point (.0 / .5) increments, never e.g. -0.9 or +1.1 net ratings
    if (Math.round(Math.abs(val) * 2) !== Math.abs(val) * 2) continue;

    // Skip ML odds explicitly labeled (e.g. ML -11), W-L record parentheticals ("3-7 (-0.9)"), or corrective negations
    const prefix = clause.slice(Math.max(0, numOffset - 22), numOffset);
    const suffix = clause.slice(numOffset + numStr.length, Math.min(clause.length, numOffset + numStr.length + 22));
    if (/\b(?:ml|moneyline|h2h|o\/u|over|under|total)\s*$/i.test(prefix)) continue;
    if (/\b\d{1,2}-\d{1,2}(?:-\d{1,2})?\s*[,(\s]*$/i.test(prefix)) continue;
    if (/\b(?:not|never|instead of|rather than|isn't|aren't|wasn't|weren't|vs\.?|versus)\s*(?:a|an|the|listed as)?\s*$/i.test(prefix)) continue;

    // Find nearest preceding team within 45 chars, or nearest immediately following team if none precede
    const preceding = [...teamHits].reverse().find(t => t.end <= numOffset && numOffset - t.end <= 45);
    const targetHit = preceding || teamHits.find(t => t.start >= numOffset + numStr.length && t.start - (numOffset + numStr.length) <= 25 && !/[,.]/.test(clause.slice(numOffset + numStr.length, t.start)));
    if (!targetHit) continue;

    // Only skip when a stat/unit qualifier directly applies between the team and number or immediately follows the number
    const statPrefix = preceding ? clause.slice(preceding.end, numOffset) : prefix;
    if (DIRECT_STAT_PREFIX_RX.test(statPrefix) || DIRECT_STAT_SUFFIX_RX.test(suffix)) continue;

    // Skip corrective negations right before the team name: "not Portland -10.5"
    const beforeTeam = clause.slice(Math.max(0, targetHit.start - 20), targetHit.start);
    if (/\b(?:not|never|instead of|rather than)\s+$/i.test(beforeTeam)) continue;

    const entry = targetHit.entry;
    if (entry.spread !== 0 && Math.sign(val) !== Math.sign(entry.spread) && Math.abs(Math.abs(val) - Math.abs(entry.spread)) <= 4) {
      return {
        kind: 'sign_flip',
        entry,
        wrongNumberRaw: numStr,
        wrongNumberStart: numOffset,
        wrongNumberEnd: numOffset + numStr.length,
        reason: `${entry.teamName} spread sign mismatch: cited ${numStr}, but ${entry.teamName} is ${formatSigned(entry.spread)} (${entry.role}).`
      };
    }
    // Reject spread value/magnitude mismatch (e.g. Lobos -8.5 when tool/row spread is -7.5)
    // Skip explicit opening/movement context like "opened at -8.5", "moved from -8.5 to -7.5", "fair spread -8.5"
    const isMovementOrFairContext =
      /\b(?:open(?:ed|ing)?|prev(?:ious)?|prior|earlier|fair(?:\s+spread)?|proj(?:ected)?|model(?:ed)?|line\s+moved\s+from|moved\s+from|down\s+from|up\s+from|from)\s*(?:at|of)?\s*$/i.test(prefix) ||
      /^\s*(?:to|->|→)\s*[+-]\d/i.test(suffix);
    if (
      !isMovementOrFairContext &&
      Math.abs(val - entry.spread) > 0.01 &&
      Math.abs(val - entry.spread) <= 25
    ) {
      return {
        kind: 'value_mismatch',
        entry,
        wrongNumberRaw: numStr,
        wrongNumberStart: numOffset,
        wrongNumberEnd: numOffset + numStr.length,
        reason: `${entry.teamName} spread mismatch: cited ${numStr}, but authoritative tool/row spread is ${formatSigned(entry.spread)}.`
      };
    }
  }

  // 2. Check favorite / underdog role contradictions per team hit
  const clauseSeparatorRx = /\b(?:while|whereas|although|though|but|and|over|against|vs\.?|versus|facing|at|@)\b|,/gi;
  for (let i = 0; i < teamHits.length; i++) {
    const hit = teamHits[i];
    const entry = hit.entry;
    const nextHitStart = i + 1 < teamHits.length ? teamHits[i + 1].start : clause.length;
    const rawAfter = clause.slice(hit.end, Math.min(nextHitStart, hit.end + 55));
    const afterSep = rawAfter.search(/\b(?:while|whereas|although|though|but)\b/i);
    const spanAfter = afterSep >= 0 ? rawAfter.slice(0, afterSep) : rawAfter;

    const rawBeforeStart = Math.max(i > 0 ? teamHits[i - 1].end : 0, hit.start - 35);
    const rawBefore = clause.slice(rawBeforeStart, hit.start);
    let lastSepEnd = 0;
    let sepMatch: RegExpExecArray | null;
    clauseSeparatorRx.lastIndex = 0;
    while ((sepMatch = clauseSeparatorRx.exec(rawBefore)) !== null) {
      lastSepEnd = sepMatch.index + sepMatch[0].length;
    }
    // If there's a preceding team and no clause/preposition boundary separated it, words immediately after team[i-1] belong to team[i-1]
    const spanBefore = (i > 0 && lastSepEnd === 0) ? '' : rawBefore.slice(lastSepEnd);

    if (entry.venue === 'away') {
      const homeAfter = spanAfter.match(/\b(?:at\s+home|hosting|home)\b/i);
      const homeBefore = spanBefore.match(/\b(?:at\s+home|hosting|home)\b/i);
      const homeMatch = homeAfter ? { text: spanAfter, idx: homeAfter.index! } : (homeBefore ? { text: spanBefore, idx: homeBefore.index! } : null);
      if (homeMatch) {
        const localPre = homeMatch.text.slice(Math.max(0, homeMatch.idx - 28), homeMatch.idx);
        const isNegated = /\b(?:not|never|no|isn't|aren't|away\s+from)\b/i.test(localPre);
        const refersToOpponent = /\b(?:against|vs\.?|versus|facing|on\s+the\s+road\s+at)\b/i.test(localPre);
        if (!isNegated && !refersToOpponent) {
          return {
            kind: 'role_flip',
            entry,
            reason: `${entry.teamName} venue mismatch: described as home, but ${entry.teamName} is the away team.`
          };
        }
      }
    } else if (entry.venue === 'home') {
      const awayAfter = spanAfter.match(/\b(?:on\s+the\s+road|road|away)\b/i);
      const awayBefore = spanBefore.match(/\b(?:on\s+the\s+road|road|away)\b/i);
      const awayMatch = awayAfter ? { text: spanAfter, idx: awayAfter.index! } : (awayBefore ? { text: spanBefore, idx: awayBefore.index! } : null);
      if (awayMatch) {
        const localPre = awayMatch.text.slice(Math.max(0, awayMatch.idx - 28), awayMatch.idx);
        const isNegated = /\b(?:not|never|no|isn't|aren't|away\s+from)\b/i.test(localPre);
        const refersToOpponent = /\b(?:against|vs\.?|versus|facing)\b/i.test(localPre);
        if (!isNegated && !refersToOpponent) {
          return {
            kind: 'role_flip',
            entry,
            reason: `${entry.teamName} venue mismatch: described as away/road, but ${entry.teamName} is the home team.`
          };
        }
      }
    }

    if (entry.role === 'pickem') continue;

    if (entry.role === 'underdog') {
      const favAfter = spanAfter.match(/\b(?:favored|favorite|favorites|chalk|laying\s+[+-]?\d+(?:\.\d+)?)\b/i);
      const favBefore = spanBefore.match(/\b(?:favored|favorite|favorites|chalk)\b/i);
      const favMatch = favAfter ? { text: spanAfter, idx: favAfter.index! } : (favBefore ? { text: spanBefore, idx: favBefore.index! } : null);
      if (favMatch) {
        const localPre = favMatch.text.slice(Math.max(0, favMatch.idx - 28), favMatch.idx);
        const isNegated = /\b(?:not|never|hardly|no|isn't|aren't|wasn't|weren't)\b/i.test(localPre);
        const refersToOpponent = /\b(?:against|vs\.?|versus|facing|over|beat(?:ing)?|upset(?:ting)?|to beat)\b/i.test(localPre);
        if (!isNegated && !refersToOpponent) {
          return {
            kind: 'role_flip',
            entry,
            reason: `${entry.teamName} role mismatch: called favorite/favored, but ${entry.teamName} is ${formatSigned(entry.spread)} (underdog).`
          };
        }
      }
    } else if (entry.role === 'favorite') {
      const dogAfter = spanAfter.match(/\b(?:underdog|underdogs|the dog|road dog|home dog|getting\s+[+-]?\d+(?:\.\d+)?)\b/i);
      const dogBefore = spanBefore.match(/\b(?:underdog|underdogs|road dog|home dog)\b/i);
      const dogMatch = dogAfter ? { text: spanAfter, idx: dogAfter.index! } : (dogBefore ? { text: spanBefore, idx: dogBefore.index! } : null);
      if (dogMatch) {
        const localPre = dogMatch.text.slice(Math.max(0, dogMatch.idx - 28), dogMatch.idx);
        const isNegated = /\b(?:not|never|hardly|no|isn't|aren't|wasn't|weren't)\b/i.test(localPre);
        const refersToOpponent = /\b(?:against|vs\.?|versus|facing|over|vs)\b/i.test(localPre);
        if (!isNegated && !refersToOpponent) {
          return {
            kind: 'role_flip',
            entry,
            reason: `${entry.teamName} role mismatch: called underdog, but ${entry.teamName} is ${formatSigned(entry.spread)} (favorite).`
          };
        }
      }
    }
  }

  return null;
}

function splitClausesPreservingDelimiters(text: string): string[] {
  if (!text) return [];
  return text.split(/(?<=[.!?\n;])\s+/).filter(Boolean);
}

function sanitizeSpreadText(text: string, spreadMap: Map<string, AuthoritativeTeamSpread>): { text: string; changed: boolean } {
  if (!text || spreadMap.size === 0) return { text, changed: false };
  const clauses = splitClausesPreservingDelimiters(text);
  const kept: string[] = [];
  let changed = false;

  for (const rawClause of clauses) {
    let clause = rawClause;
    const initialViolation = findSpreadSideViolationInClause(clause, spreadMap);
    if (!initialViolation) {
      kept.push(clause);
      continue;
    }

    // Attempt deterministic sign fix ONLY when the clause is a clean sign flip (not a role flip or "was a -10.5")
    if (
      initialViolation.kind === 'sign_flip' &&
      initialViolation.wrongNumberRaw &&
      initialViolation.wrongNumberStart !== undefined &&
      initialViolation.wrongNumberEnd !== undefined &&
      !/\b(?:is|are|was|were)\s+a\s+[+-]?\d/i.test(clause)
    ) {
      let guard = 0;
      let candidate = clause;
      while (guard < 4) {
        guard++;
        const v = findSpreadSideViolationInClause(candidate, spreadMap);
        if (!v) break;
        if (v.kind === 'sign_flip' && v.wrongNumberStart !== undefined && v.wrongNumberEnd !== undefined) {
          const rightStr = formatSigned(v.entry.spread);
          candidate = candidate.slice(0, v.wrongNumberStart) + rightStr + candidate.slice(v.wrongNumberEnd);
        } else {
          break;
        }
      }
      if (!findSpreadSideViolationInClause(candidate, spreadMap)) {
        kept.push(candidate);
        changed = true;
        continue;
      }
    }

    // Otherwise strip the violating clause so a flipped sign/role never survives in final output
    changed = true;
  }

  if (!changed) return { text, changed: false };
  return { text: kept.join(' ').trim(), changed: true };
}

function buildSpreadVetoLegTarget(entry: AuthoritativeTeamSpread, reason: string, rowId?: string): MarketVetoLegTarget {
  return {
    ...(rowId ? { rowId } : {}),
    ...(entry.eventId ? { eventId: entry.eventId } : {}),
    teamLabel: entry.teamName,
    teamAliases: Array.from(new Set([entry.teamName.toLowerCase(), ...entry.aliases, ...(entry.abbr ? [entry.abbr.toLowerCase()] : [])])),
    reason: reason.slice(0, 140)
  };
}

/**
 * Deterministic Critic audit for:
 *  A) Market coverage (ML is covered when ml_home or ml_away is present; fails if tool checked and market truly absent)
 *  B) Row side binding (each cited R-id must match the team, market type, and line/sign of the picked leg)
 *  C) Spread side & sign consistency (a negative spread is favorite, positive is underdog; never flip the sign for a team)
 */
export function auditMarketCoverageAndRowBinding(
  proposal: any,
  toolEvidenceText: string,
  boardSource: unknown,
  headersInput?: GameHeader[],
  toolRecords?: MarketToolRecord[]
): MarketRowAuditResult {
  const headers = headersInput && headersInput.length > 0
    ? headersInput
    : parseGameHeaders(boardSource);
  const rowMap = extractRowOptions([boardSource], headers);

  const boardText = extractBoardText(boardSource);

  const coverageByGame = extractMarketCoverageByGame(toolEvidenceText, boardText, headers, toolRecords);
  const authoritativeSpreads = extractAuthoritativeTeamSpreads(headers, rowMap, toolEvidenceText, toolRecords, boardText);
  const picks = extractProposalPicks(proposal, headers, rowMap);
  const flags: string[] = [];

  for (const item of picks) {
    // 1. Row Side Binding Check
    if (item.rowId && rowMap.has(item.rowId)) {
      const rowEntry = rowMap.get(item.rowId)!;
      const check = checkRowSideBinding(item.rowId, item.sideText, rowEntry, item.marketField);
      if (!check.valid) {
        flags.push('row_side_mismatch');
        if (check.isValueMismatch) flags.push('spread_value_mismatch');
        const msg = `Veto: Row side mismatch — ${check.reason}`;
        if (check.isValueMismatch) {
          const contextTeams = [rowEntry.away, rowEntry.home].filter((t): t is string => Boolean(t));
          const resolved = resolveTeamFromText(item.sideText || rowEntry.text, rowEntry.sport, contextTeams);
          const target: MarketVetoLegTarget = {
            rowId: item.rowId,
            ...(item.eventId ? { eventId: item.eventId } : (rowEntry.eventId ? { eventId: rowEntry.eventId } : {})),
            ...(resolved?.name ? { teamLabel: resolved.name } : {}),
            teamAliases: resolved ? [resolved.name.toLowerCase()] : [],
            reason: msg.slice(0, 140)
          };
          return {
            pass: false,
            feedback: msg,
            flags,
            vetoedLegs: [target]
          };
        }
        return {
          pass: false,
          feedback: msg,
          flags
        };
      }
    }

    // 1b. Spread side, sign & value check for rowless or role-contradicted picks
    if (authoritativeSpreads.size > 0) {
      const pickViolation = findSpreadSideViolationInClause(item.sideText, authoritativeSpreads);
      if (pickViolation) {
        const flagName = pickViolation.kind === 'value_mismatch' ? 'spread_value_mismatch' : 'spread_side_mismatch';
        flags.push(flagName);
        if (!flags.includes('spread_side_mismatch')) flags.push('spread_side_mismatch');
        const msg = pickViolation.kind === 'value_mismatch'
          ? `Veto: CRITIC AUDIT spread mismatch — ${pickViolation.reason}`
          : `Veto: SPREAD SIDE mismatch — ${pickViolation.reason}`;
        return {
          pass: false,
          feedback: msg,
          flags,
          ...(pickViolation.kind === 'value_mismatch'
            ? { vetoedLegs: [buildSpreadVetoLegTarget(pickViolation.entry, msg, item.rowId)] }
            : {})
        };
      }
      if (typeof item.pick === 'object' && item.pick && typeof item.pick.reason === 'string') {
        const reasonViolation = findSpreadSideViolationInClause(item.pick.reason, authoritativeSpreads);
        if (reasonViolation) {
          const flagName = reasonViolation.kind === 'value_mismatch' ? 'spread_value_mismatch' : 'spread_side_mismatch';
          flags.push(flagName);
          if (!flags.includes('spread_side_mismatch')) flags.push('spread_side_mismatch');
          const msg = reasonViolation.kind === 'value_mismatch'
            ? `Veto: CRITIC AUDIT spread mismatch in pick reasoning — ${reasonViolation.reason}`
            : `Veto: SPREAD SIDE mismatch in pick reasoning — ${reasonViolation.reason}`;
          return {
            pass: false,
            feedback: msg,
            flags,
            ...(reasonViolation.kind === 'value_mismatch'
              ? { vetoedLegs: [buildSpreadVetoLegTarget(reasonViolation.entry, msg, item.rowId)] }
              : {})
          };
        }
      }
    }

    // 2. Market Coverage Check (only enforce failure when market tool was actually pulled for that game)
    if (item.eventId) {
      const cov = coverageByGame.get(item.eventId);
      if (cov && cov.marketToolChecked) {
        const pickIsML = isMoneylineText(item.sideText, item.marketField);
        const pickOU = extractOverUnder(item.sideText);
        const pickSpread = extractSpreadNumber(item.sideText);

        const buildMarketVetoTarget = (reason: string): MarketVetoLegTarget => {
          const rowEntry = item.rowId ? rowMap.get(item.rowId) : undefined;
          const contextTeams = rowEntry ? [rowEntry.away, rowEntry.home].filter((t): t is string => Boolean(t)) : undefined;
          const resolved = resolveTeamFromText(item.sideText || rowEntry?.text || '', rowEntry?.sport, contextTeams);
          const teamEntry = resolved
            ? ESPN_TEAMS.find(t => `${t.sport}:${t.abbr}` === resolved.canonical || t.name === resolved.name)
            : undefined;
          const aliases = teamEntry
            ? Array.from(new Set([teamEntry.name.toLowerCase(), teamEntry.city.toLowerCase(), teamEntry.nickname.toLowerCase(), teamEntry.abbr.toLowerCase(), ...teamEntry.aliases]))
            : (resolved ? [resolved.name.toLowerCase()] : []);
          return {
            ...(item.rowId ? { rowId: item.rowId } : {}),
            eventId: item.eventId,
            ...(resolved?.name ? { teamLabel: resolved.name } : {}),
            teamAliases: aliases,
            reason: reason.slice(0, 140)
          };
        };

        if (pickIsML && !cov.hasMoneyline) {
          flags.push('missing_moneyline_coverage');
          const msg = `Veto: Missing moneyline coverage for ${item.eventId}; tool result and board do not contain ml_home or ml_away.`;
          return {
            pass: false,
            feedback: msg,
            flags,
            vetoedLegs: [buildMarketVetoTarget(msg)]
          };
        }
        if (pickOU && !cov.hasTotal) {
          flags.push('missing_total_coverage');
          const msg = `Veto: Missing total coverage for ${item.eventId}.`;
          return {
            pass: false,
            feedback: msg,
            flags,
            vetoedLegs: [buildMarketVetoTarget(msg)]
          };
        }
        if (pickSpread !== null && !cov.hasSpread && !pickIsML && !pickOU) {
          flags.push('missing_spread_coverage');
          const msg = `Veto: Missing spread coverage for ${item.eventId}.`;
          return {
            pass: false,
            feedback: msg,
            flags,
            vetoedLegs: [buildMarketVetoTarget(msg)]
          };
        }
      }
    }
  }

  // 3. Check prose fields (summary, analysis, insights, scorecards, components) for spread sign/role flips
  if (authoritativeSpreads.size > 0 && proposal && typeof proposal === 'object') {
    const proseTexts: string[] = [];
    for (const key of ['summary', 'analysis', 'reason', 'rationale', 'conclusion']) {
      if (typeof proposal[key] === 'string' && proposal[key].trim()) proseTexts.push(proposal[key]);
    }
    if (Array.isArray(proposal.insights)) {
      for (const ins of proposal.insights) {
        if (typeof ins === 'string' && ins.trim()) proseTexts.push(ins);
      }
    }
    if (Array.isArray(proposal.anomalies)) {
      for (const anom of proposal.anomalies) {
        if (typeof anom === 'string' && anom.trim()) proseTexts.push(anom);
      }
    }
    const checkScorecard = (sc: any) => {
      if (!sc || typeof sc !== 'object') return;
      if (typeof sc.summary === 'string' && sc.summary.trim()) proseTexts.push(sc.summary);
      if (typeof sc.analysis === 'string' && sc.analysis.trim()) proseTexts.push(sc.analysis);
    };
    if (proposal.scorecard) checkScorecard(proposal.scorecard);
    if (Array.isArray(proposal.scorecards)) proposal.scorecards.forEach(checkScorecard);
    if (Array.isArray(proposal.components)) {
      for (const comp of proposal.components) {
        if (!comp || typeof comp !== 'object' || !comp.props) continue;
        for (const pKey of ['title', 'subtitle', 'value']) {
          if (typeof comp.props[pKey] === 'string' && comp.props[pKey].trim()) proseTexts.push(comp.props[pKey]);
        }
        if (Array.isArray(comp.props.insights)) {
          for (const ins of comp.props.insights) {
            if (typeof ins === 'string' && ins.trim()) proseTexts.push(ins);
            else if (ins && typeof ins === 'object' && typeof ins.message === 'string' && ins.message.trim()) proseTexts.push(ins.message);
          }
        }
        if (Array.isArray(comp.props.rows)) {
          for (const row of comp.props.rows) {
            if (!row || typeof row !== 'object') continue;
            for (const val of Object.values(row)) {
              if (typeof val === 'string' && val.trim()) proseTexts.push(val);
            }
          }
        }
      }
    }

    for (const txt of proseTexts) {
      for (const clause of splitClausesPreservingDelimiters(txt)) {
        const violation = findSpreadSideViolationInClause(clause, authoritativeSpreads);
        if (violation) {
          const flagName = violation.kind === 'value_mismatch' ? 'spread_value_mismatch' : 'spread_side_mismatch';
          flags.push(flagName);
          if (!flags.includes('spread_side_mismatch')) flags.push('spread_side_mismatch');
          const msg = violation.kind === 'value_mismatch'
            ? `Veto: CRITIC AUDIT spread mismatch — ${violation.reason}`
            : `Veto: SPREAD SIDE mismatch — ${violation.reason}`;
          return {
            pass: false,
            feedback: msg,
            flags
          };
        }
      }
    }
  }

  return { pass: true, flags };
}

/**
 * Detects false-negative Critic rejections that claim a moneyline leg is "spread only" /
 * "missing moneyline" when ml_home or ml_away WAS actually returned for every ML leg.
 */
const FALSE_MISSING_ML_REGEX =
  /only shows a spread|spread[- ]only|missing (?:a )?(?:moneyline|\bml\b)|no (?:moneyline|\bml\b) (?:market|odds|coverage|data|available)|(?:moneyline|\bml\b)[^.]{0,40}(?:not (?:present|found|covered|available|supported|returned)|missing|uncovered|unavailable)|lack(?:s|ing)?(?:\s+of)?(?:\s+verified)?\s+market\s+data|no\s+market\s+(?:data|pricing)/i;

export function scrubFalseMissingMarketClause(text: string): string {
  if (!text) return '';
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  const kept = sentences.filter(s => s.trim() && !FALSE_MISSING_ML_REGEX.test(s));
  return kept.join(' ').replace(/\s{2,}/g, ' ').trim();
}

export function isFalseMissingMoneylineCritique(
  feedback: string,
  proposal: any,
  toolEvidenceText: string,
  boardSource: unknown,
  headersInput?: GameHeader[],
  toolRecords?: MarketToolRecord[]
): boolean {
  if (!feedback || !proposal || typeof proposal !== 'object') return false;
  const fLower = feedback.toLowerCase();

  const claimsMissingML = FALSE_MISSING_ML_REGEX.test(fLower);
  if (!claimsMissingML) return false;

  // Never override if Critic also flagged any other real defect
  if (
    /\b(?:injur|scratch|rule violation|wrong team|misattribut|row.{0,20}mismatch|spread.{0,20}(?:mismatch|sign|flip)|favorite.{0,20}underdog|underdog.{0,20}favorite|opposite side|does not match|away.{0,15}home|fabricat|ungrounded|grounding|relatively healthy|goals allowed|single bet)\b/i.test(
      fLower
    )
  ) {
    return false;
  }

  const headers = headersInput && headersInput.length > 0 ? headersInput : parseGameHeaders(boardSource);
  const rowMap = extractRowOptions([boardSource], headers);
  const boardText = extractBoardText(boardSource);
  const coverageByGame = extractMarketCoverageByGame(toolEvidenceText, boardText, headers, toolRecords);
  const picks = extractProposalPicks(proposal, headers, rowMap);
  const mlPicks = picks.filter(p => isMoneylineText(p.sideText, p.marketField));
  if (mlPicks.length === 0) return false;

  // Every moneyline leg must genuinely have ml_home or ml_away coverage
  return mlPicks.every(p => {
    if (!p.eventId) return false;
    const cov = coverageByGame.get(p.eventId);
    return Boolean(cov && cov.hasMoneyline);
  });
}

export interface SanitizeMarketRowOptions {
  toolEvidenceText?: string;
  toolRecords?: MarketToolRecord[];
}

/**
 * Strips any picks whose cited row ID conflicts with the picked team/side/line,
 * and fixes or strips spread-sign or favorite/underdog role mismatches in picks and prose.
 */
export function sanitizeRowMismatchedPicks<T extends Record<string, any>>(
  report: T,
  boardSource: unknown,
  headersInput?: GameHeader[],
  options?: SanitizeMarketRowOptions
): T {
  if (!report || typeof report !== 'object') return report;
  const headers = headersInput && headersInput.length > 0 ? headersInput : parseGameHeaders(boardSource);
  const rowMap = extractRowOptions([boardSource], headers);
  const boardText = extractBoardText(boardSource);
  const authoritativeSpreads = extractAuthoritativeTeamSpreads(
    headers,
    rowMap,
    options?.toolEvidenceText,
    options?.toolRecords,
    boardText
  );
  if (rowMap.size === 0 && authoritativeSpreads.size === 0) return report;

  const isPickValid = (pk: any): boolean => {
    if (!pk || typeof pk !== 'object') {
      const text = String(pk || '');
      const m = text.match(/\b(R\d+)\b/i);
      if (m && rowMap.has(m[1].toUpperCase())) {
        if (!checkRowSideBinding(m[1].toUpperCase(), text, rowMap.get(m[1].toUpperCase())!).valid) return false;
      }
      if (authoritativeSpreads.size > 0 && findSpreadSideViolationInClause(text, authoritativeSpreads)) {
        return false;
      }
      return true;
    }
    const rowId = typeof pk.row === 'string' && /^R\d+$/i.test(pk.row.trim())
      ? pk.row.trim().toUpperCase()
      : (typeof pk.id === 'string' && /^R\d+$/i.test(pk.id.trim()) ? pk.id.trim().toUpperCase() : undefined);
    const sideText = [pk.side, pk.pick, pk.selection, pk.team, pk.note]
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .join(' ')
      .trim();
    if (rowId && rowMap.has(rowId)) {
      if (!checkRowSideBinding(rowId, sideText, rowMap.get(rowId)!, pk.market).valid) return false;
    }
    if (authoritativeSpreads.size > 0 && sideText && findSpreadSideViolationInClause(sideText, authoritativeSpreads)) {
      return false;
    }
    return true;
  };

  const rep = report as Record<string, any>;
  if (Array.isArray(rep.picks)) {
    rep.picks = rep.picks.filter(isPickValid);
    if (authoritativeSpreads.size > 0) {
      for (const pk of rep.picks) {
        if (pk && typeof pk === 'object' && typeof pk.reason === 'string') {
          const cleaned = sanitizeSpreadText(pk.reason, authoritativeSpreads);
          if (cleaned.changed) {
            pk.reason = cleaned.text || 'Line verified against market row.';
          }
        }
      }
    }
  }

  if (rep.scorecard && Array.isArray(rep.scorecard.picks)) {
    rep.scorecard.picks = rep.scorecard.picks.filter(isPickValid);
  }
  if (Array.isArray(rep.scorecards)) {
    for (const sc of rep.scorecards) {
      if (sc && Array.isArray(sc.picks)) {
        sc.picks = sc.picks.filter(isPickValid);
      }
    }
  }

  if (authoritativeSpreads.size > 0) {
    for (const key of ['summary', 'analysis', 'reason', 'rationale', 'conclusion']) {
      if (typeof rep[key] === 'string' && rep[key].trim()) {
        const cleaned = sanitizeSpreadText(rep[key], authoritativeSpreads);
        if (cleaned.changed) {
          rep[key] = cleaned.text || 'Analysis updated to match slate spread sides.';
        }
      }
    }
    for (const arrKey of ['insights', 'anomalies']) {
      if (Array.isArray(rep[arrKey])) {
        rep[arrKey] = rep[arrKey]
          .map((item: any) => (typeof item === 'string' ? sanitizeSpreadText(item, authoritativeSpreads).text : item))
          .filter((item: any) => typeof item !== 'string' || item.trim().length > 0);
      }
    }
    const cleanScorecardText = (sc: any) => {
      if (!sc || typeof sc !== 'object') return;
      for (const k of ['summary', 'analysis']) {
        if (typeof sc[k] === 'string' && sc[k].trim()) {
          const cleaned = sanitizeSpreadText(sc[k], authoritativeSpreads);
          if (cleaned.changed) {
            sc[k] = cleaned.text || 'Analysis updated to match slate spread sides.';
          }
        }
      }
    };
    if (rep.scorecard) cleanScorecardText(rep.scorecard);
    if (Array.isArray(rep.scorecards)) rep.scorecards.forEach(cleanScorecardText);

    if (Array.isArray(rep.components)) {
      for (const comp of rep.components) {
        if (!comp || typeof comp !== 'object' || !comp.props) continue;
        for (const pKey of ['title', 'subtitle', 'value']) {
          if (typeof comp.props[pKey] === 'string') {
            const cleaned = sanitizeSpreadText(comp.props[pKey], authoritativeSpreads);
            if (cleaned.changed) comp.props[pKey] = cleaned.text;
          }
        }
        if (Array.isArray(comp.props.insights)) {
          comp.props.insights = comp.props.insights
            .map((ins: any) => {
              if (typeof ins === 'string') return sanitizeSpreadText(ins, authoritativeSpreads).text;
              if (ins && typeof ins === 'object' && typeof ins.message === 'string') {
                const cleaned = sanitizeSpreadText(ins.message, authoritativeSpreads);
                return cleaned.text ? { ...ins, message: cleaned.text } : null;
              }
              return ins;
            })
            .filter((ins: any) => ins !== null && (typeof ins !== 'string' || ins.trim().length > 0));
        }
        if (Array.isArray(comp.props.rows)) {
          comp.props.rows = comp.props.rows.map((row: any) => {
            if (!row || typeof row !== 'object') return row;
            const nextRow = { ...row };
            for (const rk of Object.keys(nextRow)) {
              if (typeof nextRow[rk] === 'string') {
                const cleaned = sanitizeSpreadText(nextRow[rk], authoritativeSpreads);
                if (cleaned.changed) nextRow[rk] = cleaned.text;
              }
            }
            return nextRow;
          });
        }
      }
    }
  }

  return report;
}
