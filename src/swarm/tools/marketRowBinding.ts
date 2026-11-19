import { parseGameHeaders, getEventIdForPick, type GameHeader } from '../context/gameHeaders.ts';
import { ESPN_TEAMS, normalizeSportHint, type EspnTeamEntry } from './injuryAttribution.ts';

export const MARKET_AND_ROW_RULES = `MARKET AND ROW RULES:
- A moneyline is covered when the tool or board has ml_home or ml_away for that game.
- Do not reject a ML leg solely because a spread is also present.
- Cite the row ID for the exact side you are picking.
- Never assign a row to the opposite team or the opposite side of the line.`;

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

export interface MarketRowAuditResult {
  pass: boolean;
  feedback?: string;
  flags: string[];
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
          const body = cells.slice(1).join(' | ');
          addEntry({ rowId, text: body });
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

function resolveTeamFromText(
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

function extractSpreadNumber(text: string): number | null {
  if (!text) return null;
  const cleaned = stripOddsParentheses(text);
  // Ignore explicit ML odds like "ML -166"
  if (/\b(?:ml|moneyline|money\s*line|h2h)\b/i.test(cleaned) && !/[+-]\d+(?:\.5|\.0)\b/.test(cleaned)) {
    return null;
  }
  const matches = cleaned.match(/(?:^|[\s,:(])([+-]\d+(?:\.\d+)?)(?=$|[\s,);])/g);
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
): { valid: boolean; reason?: string } {
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
    return {
      valid: false,
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

/**
 * Deterministic Critic audit for:
 *  A) Market coverage (ML is covered when ml_home or ml_away is present; fails if tool checked and market truly absent)
 *  B) Row side binding (each cited R-id must match the team, market type, and line/sign of the picked leg)
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

  let boardText = '';
  if (typeof boardSource === 'string') {
    boardText = boardSource;
  } else if (boardSource && typeof boardSource === 'object') {
    const b = boardSource as any;
    boardText = [b.rawBoard, b.board, b.dataSample, b.task, b.content].filter(Boolean).join('\n');
  }

  const coverageByGame = extractMarketCoverageByGame(toolEvidenceText, boardText, headers, toolRecords);
  const picks = extractProposalPicks(proposal, headers, rowMap);
  const flags: string[] = [];

  for (const item of picks) {
    // 1. Row Side Binding Check
    if (item.rowId && rowMap.has(item.rowId)) {
      const rowEntry = rowMap.get(item.rowId)!;
      const check = checkRowSideBinding(item.rowId, item.sideText, rowEntry, item.marketField);
      if (!check.valid) {
        flags.push('row_side_mismatch');
        return {
          pass: false,
          feedback: `Veto: Row side mismatch — ${check.reason}`,
          flags
        };
      }
    }

    // 2. Market Coverage Check (only enforce failure when market tool was actually pulled for that game)
    if (item.eventId) {
      const cov = coverageByGame.get(item.eventId);
      if (cov && cov.marketToolChecked) {
        const pickIsML = isMoneylineText(item.sideText, item.marketField);
        const pickOU = extractOverUnder(item.sideText);
        const pickSpread = extractSpreadNumber(item.sideText);

        if (pickIsML && !cov.hasMoneyline) {
          flags.push('missing_moneyline_coverage');
          return {
            pass: false,
            feedback: `Veto: Missing moneyline coverage for ${item.eventId}; tool result and board do not contain ml_home or ml_away.`,
            flags
          };
        }
        if (pickOU && !cov.hasTotal) {
          flags.push('missing_total_coverage');
          return {
            pass: false,
            feedback: `Veto: Missing total coverage for ${item.eventId}.`,
            flags
          };
        }
        if (pickSpread !== null && !cov.hasSpread && !pickIsML && !pickOU) {
          flags.push('missing_spread_coverage');
          return {
            pass: false,
            feedback: `Veto: Missing spread coverage for ${item.eventId}.`,
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

  const claimsMissingML =
    /only shows a spread|spread[- ]only|missing (?:a )?(?:moneyline|\bml\b)|no (?:moneyline|\bml\b) (?:market|odds|coverage|data|available)|(?:moneyline|\bml\b)[^.]{0,40}(?:not (?:present|found|covered|available|supported|returned)|missing|uncovered|unavailable)/i.test(
      fLower
    );
  if (!claimsMissingML) return false;

  // Never override if Critic also flagged any other real defect
  if (
    /\b(?:injur|scratch|rule violation|wrong team|misattribut|row.{0,20}mismatch|opposite side|does not match|away.{0,15}home|fabricat)/i.test(
      fLower
    )
  ) {
    return false;
  }

  const headers = headersInput && headersInput.length > 0 ? headersInput : parseGameHeaders(boardSource);
  const rowMap = extractRowOptions([boardSource], headers);
  let boardText = '';
  if (typeof boardSource === 'string') boardText = boardSource;
  else if (boardSource && typeof boardSource === 'object') {
    const b = boardSource as any;
    boardText = [b.rawBoard, b.board, b.dataSample, b.task, b.content].filter(Boolean).join('\n');
  }
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

/**
 * Strips any picks whose cited row ID conflicts with the picked team/side/line.
 */
export function sanitizeRowMismatchedPicks<T extends Record<string, any>>(
  report: T,
  boardSource: unknown,
  headersInput?: GameHeader[]
): T {
  if (!report || typeof report !== 'object') return report;
  const headers = headersInput && headersInput.length > 0 ? headersInput : parseGameHeaders(boardSource);
  const rowMap = extractRowOptions([boardSource], headers);
  if (rowMap.size === 0) return report;

  const rep = report as Record<string, any>;
  if (Array.isArray(rep.picks)) {
    rep.picks = rep.picks.filter((pk: any) => {
      if (!pk || typeof pk !== 'object') {
        const m = String(pk || '').match(/\b(R\d+)\b/i);
        if (m && rowMap.has(m[1].toUpperCase())) {
          return checkRowSideBinding(m[1].toUpperCase(), String(pk || ''), rowMap.get(m[1].toUpperCase())!).valid;
        }
        return true;
      }
      const rowId = typeof pk.row === 'string' && /^R\d+$/i.test(pk.row.trim())
        ? pk.row.trim().toUpperCase()
        : (typeof pk.id === 'string' && /^R\d+$/i.test(pk.id.trim()) ? pk.id.trim().toUpperCase() : undefined);
      if (!rowId || !rowMap.has(rowId)) return true;
      const sideText = [pk.side, pk.pick, pk.selection, pk.team, pk.note]
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .join(' ')
        .trim();
      return checkRowSideBinding(rowId, sideText, rowMap.get(rowId)!, pk.market).valid;
    });
  }

  return report;
}
