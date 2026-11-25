/**
 * Lean compact-slate game headers.
 * Extracts event IDs, matchup metadata, and option citations from compact-slate lines,
 * completely excluding raw board tables and Markdown grids to stay <= 1600 chars.
 */

export interface GameHeaderOption {
  id: string; // e.g. "R1", "R2"
  text: string; // e.g. "KC -3.5 (-110)"
}

export interface GameHeader {
  eventId: string;
  sport: string;
  away: string;
  home: string;
  commence?: string;
  modelSignal?: string;
  options: GameHeaderOption[];
}

const EVENT_PREFIX_SPORT_MAP: Record<string, string> = {
  'college-football': 'ncaaf',
  'college-basketball': 'ncaab'
};

function inferSportFromEventId(eventId: string): string {
  const clean = eventId.trim().toLowerCase();
  const prefixMatch =
    clean.match(/^([a-z][a-z0-9_-]*?)-\d+$/) ??
    clean.match(/^(college-football|college-basketball|[a-z][a-z0-9_]*)-/);
  const prefix = prefixMatch?.[1];
  if (!prefix) return 'unknown';
  return EVENT_PREFIX_SPORT_MAP[prefix] ?? prefix;
}

/**
 * Parses DuelOdds compact-slate lines:
 * "event_id=<id> | sport=<sport> | <away> @ <home> | commence=<time> | options: R1 ... , R2 ..."
 * Ignores any table grids, CSVs, or "id|game|market" rows.
 */
export function parseGameHeaders(data: unknown, fallbackEventIds?: string[]): GameHeader[] {
  const headers: GameHeader[] = [];

  let text = '';
  if (typeof data === 'string') {
    text = data;
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    text = [
      typeof obj.task === 'string' ? obj.task : '',
      typeof obj.rawBoard === 'string' ? obj.rawBoard : '',
      typeof obj.board === 'string' ? obj.board : '',
      typeof obj.content === 'string' ? obj.content : ''
    ].join('\n');
  }

  const parseOptionsSegment = (segment: string, options: GameHeaderOption[]) => {
    const rawOpts = segment.replace(/^(?:options:|rows=)\s*/i, '').trim();
    // Options format: "R1 KC -3.5 (-110), R2 BUF +3.5 (-110)" or "R1:ML KC(-110),R2:SPR BUF +3.5(-110)"
    const optItems = rawOpts.split(/[,;]\s*(?=R\d+)/);
    for (const item of optItems) {
      const match = item.trim().match(/^(R\d+)[:\s]*(.*)$/);
      if (match) {
        options.push({
          id: match[1],
          text: match[2]?.trim() || match[1]
        });
      }
    }
  };

  if (text) {
    const lines = text.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('|') || line.includes('id|game|market') || line.includes('RAW ACTIONABLE')) {
        // Explicitly never parse board tables
        continue;
      }

      if (line.includes('event_id=') && (line.includes('sport=') || line.includes('@'))) {
        const parts = line.split('|').map(p => p.trim());
        let eventId = '';
        let sport = 'unknown';
        let away = 'Away';
        let home = 'Home';
        let commence: string | undefined = undefined;
        let modelSignal: string | undefined = undefined;
        const options: GameHeaderOption[] = [];
        let spRaw: string | undefined;
        let mlRaw: string | undefined;
        let totRaw: string | undefined;

        for (const p of parts) {
          if (p.startsWith('event_id=')) {
            eventId = p.replace('event_id=', '').trim();
          } else if (p.startsWith('sport=')) {
            sport = p.replace('sport=', '').trim();
          } else if (p.startsWith('commence=')) {
            commence = p.replace('commence=', '').trim();
          } else if (p.startsWith('model_signal=')) {
            modelSignal = p.replace('model_signal=', '').trim();
          } else if (p.includes('@')) {
            const teams = p.split('@').map(t => t.trim());
            if (teams.length === 2 && teams[0] && teams[1]) {
              away = teams[0];
              home = teams[1];
            }
          } else if (p.toLowerCase().startsWith('options:') || p.toLowerCase().startsWith('rows=')) {
            parseOptionsSegment(p, options);
          } else if (/^sp\s+/i.test(p)) {
            spRaw = p.replace(/^sp\s+/i, '').trim();
          } else if (/^ml\s+/i.test(p)) {
            mlRaw = p.replace(/^ml\s+/i, '').trim();
          } else if (/^tot\s+/i.test(p)) {
            totRaw = p.replace(/^tot\s+/i, '').trim();
          }
        }

        if (eventId) {
          if (sport === 'unknown') {
            sport = inferSportFromEventId(eventId);
          }
          const hasExplicitRidOptions = options.some(o => Boolean(o.id));
          if (!hasExplicitRidOptions) {
            if (mlRaw && !/^n\/a$/i.test(mlRaw)) {
              const mlParts = mlRaw.split('/').map(s => s.trim());
              if (mlParts.length === 2 && mlParts[0] && mlParts[1] && !/^n\/a$/i.test(mlParts[0]) && !/^n\/a$/i.test(mlParts[1])) {
                options.push({
                  id: '',
                  text: `${away} ML ${mlParts[1]} / ${home} ML ${mlParts[0]}`
                });
              } else if (mlParts.length === 2 && mlParts[0] && !/^n\/a$/i.test(mlParts[0])) {
                options.push({
                  id: '',
                  text: `${home} ML ${mlParts[0]}`
                });
              } else if (mlParts.length === 2 && mlParts[1] && !/^n\/a$/i.test(mlParts[1])) {
                options.push({
                  id: '',
                  text: `${away} ML ${mlParts[1]}`
                });
              }
            }
            if (spRaw && !/^n\/a$/i.test(spRaw)) {
              const spNum = Number(spRaw);
              if (Number.isFinite(spNum)) {
                const homeSp = spNum > 0 ? `+${spNum}` : `${spNum}`;
                const awayNum = -spNum;
                const awaySp = awayNum > 0 ? `+${awayNum}` : `${awayNum}`;
                options.push({
                  id: '',
                  text: `${home} ${homeSp} / ${away} ${awaySp}`
                });
              }
            }
            if (totRaw && !/^n\/a$/i.test(totRaw)) {
              options.push({
                id: '',
                text: `O/U ${totRaw}`
              });
            }
          }
          headers.push({ eventId, sport, away, home, commence, ...(modelSignal ? { modelSignal } : {}), options });
        }
      } else if (line.includes('|') && line.includes('@')) {
        const parts = line.split('|').map(p => p.trim());
        if (parts.length >= 2 && /^[a-z][a-z0-9_-]*-\d+$/i.test(parts[0])) {
          const eventId = parts[0];
          let sport = inferSportFromEventId(eventId);
          let away = 'Away';
          let home = 'Home';
          let commence: string | undefined = undefined;
          let modelSignal: string | undefined = undefined;
          const options: GameHeaderOption[] = [];
          let foundMatchup = false;

          for (const p of parts.slice(1)) {
            if (p.startsWith('sport=')) {
              const explicitSport = p.replace('sport=', '').trim();
              if (explicitSport && !/^unknown$/i.test(explicitSport)) {
                sport = explicitSport;
              }
            } else if (p.startsWith('model_signal=')) {
              modelSignal = p.replace('model_signal=', '').trim();
            } else if (/^[a-z][a-z0-9_]+$/i.test(p) && !/^unknown$/i.test(p) && !p.includes('@') && !/^options:/i.test(p)) {
              sport = p.toLowerCase();
            } else if (p.startsWith('commence=')) {
              commence = p.replace('commence=', '').trim();
            } else if (/^\d{4}-\d{2}-\d{2}T\S+$/.test(p)) {
              commence = p;
            } else if (p.includes('@')) {
              const teams = p.split('@').map(t => t.trim());
              if (teams.length === 2 && teams[0] && teams[1]) {
                away = teams[0];
                home = teams[1];
                foundMatchup = true;
              }
            } else if (p.toLowerCase().startsWith('options:') || p.toLowerCase().startsWith('rows=')) {
              parseOptionsSegment(p, options);
            }
          }

          if (foundMatchup) {
            headers.push({ eventId, sport, away, home, commence, ...(modelSignal ? { modelSignal } : {}), options });
          }
        }
      }
    }
  }

  // Fallback if no compact-slate lines found: use provided eventIds with unknown teams
  if (headers.length === 0 && Array.isArray(fallbackEventIds) && fallbackEventIds.length > 0) {
    for (const id of fallbackEventIds) {
      if (typeof id === 'string' && id.trim()) {
        headers.push({
          eventId: id.trim(),
          sport: 'unknown',
          away: 'Away',
          home: 'Home',
          options: []
        });
      }
    }
  }

  return headers;
}

/**
 * Renders compact headers: one line per game, <= 6 FanDuel options keeping R citation ids.
 * Strictly bounded by maxChars (default 1600).
 */
export function renderHeaders(headers: GameHeader[], maxChars: number = 1600): string {
  if (!headers || headers.length === 0) {
    return '';
  }

  const formatLine = (h: GameHeader, maxOpts: number): string => {
    const opts = (h.options || []).slice(0, maxOpts);
    const optsStr = opts.length > 0 ? ` | options: ${opts.map(o => `${o.id ? o.id + ' ' : ''}${o.text}`).join(', ')}` : '';
    const commenceStr = h.commence ? ` | ${h.commence}` : '';
    const signalStr = h.modelSignal && (h.modelSignal === 'lean_home' || h.modelSignal === 'lean_away')
      ? ` | model_signal=${h.modelSignal}`
      : '';
    return `event_id=${h.eventId} | ${h.sport} | ${h.away} @ ${h.home}${commenceStr}${signalStr}${optsStr}`;
  };

  for (let maxOpts = 6; maxOpts >= 1; maxOpts--) {
    const lines = headers.map(h => formatLine(h, maxOpts));
    const fullText = lines.join('\n');
    if (fullText.length <= maxChars) {
      return fullText;
    }
  }

  const baseLines = headers.map(h => formatLine(h, 0));
  let totalLen = baseLines.reduce((sum, l) => sum + l.length, 0) + Math.max(0, baseLines.length - 1);
  if (totalLen <= maxChars) {
    const upgraded = [...baseLines];
    for (let i = 0; i < headers.length; i++) {
      const candidate = formatLine(headers[i], 1);
      const delta = candidate.length - upgraded[i].length;
      if (delta > 0 && totalLen + delta <= maxChars) {
        upgraded[i] = candidate;
        totalLen += delta;
      }
    }
    return upgraded.join('\n');
  }

  // Whole-line packing fallback: never slice a game header mid-line/mid-word
  const lines: string[] = [];
  let packedLen = 0;
  for (const h of headers) {
    const withOneOpt = (h.options && h.options.length > 0) ? formatLine(h, 1) : formatLine(h, 0);
    const zeroOpt = formatLine(h, 0);
    const minimal = `event_id=${h.eventId} | ${h.away} @ ${h.home}`;
    const sep = lines.length > 0 ? 1 : 0;
    let chosen: string | null = null;
    if (packedLen + sep + withOneOpt.length <= maxChars) {
      chosen = withOneOpt;
    } else if (packedLen + sep + zeroOpt.length <= maxChars) {
      chosen = zeroOpt;
    } else if (lines.length === 0 && minimal.length <= maxChars) {
      chosen = minimal;
    }
    if (!chosen) break;
    packedLen += sep + chosen.length;
    lines.push(chosen);
  }
  return lines.join('\n');
}

function escapeHeaderRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWordMatch(haystack: string, needle: string): boolean {
  const n = needle.trim();
  if (!n) return false;
  return new RegExp(`(?:^|[^a-z0-9])${escapeHeaderRx(n)}(?:$|[^a-z0-9])`, 'i').test(haystack);
}

function extractTeamMascotToken(teamName: string): string {
  const clean = teamName.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const words = clean.split(' ').filter(Boolean);
  if (words.length < 2) return '';
  const last = words[words.length - 1];
  if (words.length >= 3 && /^(sox|jackets|wings|leafs|knights|blazers|heat|jazz|magic|wild|heat|stars|blues|bruins|kings|rams|jets|nets|mets|cubs)$/i.test(last)) {
    const prev = words[words.length - 2];
    if (/^(red|white|blue|maple|golden|trail)$/i.test(prev)) {
      return `${prev} ${last}`;
    }
  }
  return last.length >= 4 ? last : '';
}

function extractTeamCityPrefix(teamName: string): string {
  const clean = teamName.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const words = clean.split(' ').filter(Boolean);
  if (words.length < 2) return '';
  return words.slice(0, words.length - 1).join(' ');
}

function scoreHeaderMatch(text: string, h: GameHeader, allHeaders: GameHeader[]): number {
  if (!text || !h) return 0;
  if (h.eventId && hasWordMatch(text, h.eventId)) return 100;

  const away = (h.away || '').trim();
  const home = (h.home || '').trim();
  if (away && home) {
    const matchupRx = new RegExp(
      `(?:^|[^a-z0-9])${escapeHeaderRx(away)}\\s*(?:@|at|vs\\.?)\\s*${escapeHeaderRx(home)}(?:$|[^a-z0-9])`,
      'i'
    );
    if (matchupRx.test(text)) return 90;
  }

  let best = 0;
  for (const team of [away, home]) {
    if (!team || /^(away|home|unknown|tbd)$/i.test(team)) continue;
    const isShortAbbr = team.length <= 4 && !team.includes(' ');
    if (!isShortAbbr && hasWordMatch(text, team)) {
      // Full team name match (e.g. "Minnesota Wild" vs "Minnesota Timberwolves")
      best = Math.max(best, 80 + Math.min(15, team.length));
      continue;
    }

    const mascot = extractTeamMascotToken(team);
    if (mascot && hasWordMatch(text, mascot)) {
      const mascotCount = allHeaders.filter(other => {
        const oa = extractTeamMascotToken(other.away || '');
        const oh = extractTeamMascotToken(other.home || '');
        return oa.toLowerCase() === mascot.toLowerCase() || oh.toLowerCase() === mascot.toLowerCase();
      }).length;
      const city = extractTeamCityPrefix(team);
      if (mascotCount === 1) {
        best = Math.max(best, 60);
      } else if (city && hasWordMatch(text, city)) {
        best = Math.max(best, 70);
      } else {
        best = Math.max(best, 35);
      }
      continue;
    }

    if (isShortAbbr && hasWordMatch(text, team)) {
      // Short abbreviation match ONLY with word boundary and lower priority than full-name/mascot
      const abbrCount = allHeaders.filter(other =>
        (other.away || '').trim().toUpperCase() === team.toUpperCase() ||
        (other.home || '').trim().toUpperCase() === team.toUpperCase()
      ).length;
      best = Math.max(best, abbrCount === 1 ? 30 : 12);
    }
  }

  return best;
}

/**
 * Maps a pick object (or string) to its corresponding event ID using parsed game headers.
 * S1: Validates cited row first and scores full team name / unique mascot strictly above
 * shared city prefixes or cross-sport abbreviations.
 */
export function getEventIdForPick(pick: any, headers: GameHeader[]): string | undefined {
  if (!pick) return undefined;
  if (typeof pick === 'string') {
    const rowMatch = pick.match(/\b(R\d+)\b/i);
    if (rowMatch) {
      const rid = rowMatch[1].toUpperCase();
      const rowHeader = headers.find(h => (h.options || []).some(o => Boolean(o.id) && o.id.toUpperCase() === rid));
      if (rowHeader) return rowHeader.eventId;
    }
    let bestHeader: GameHeader | undefined;
    let bestScore = 0;
    for (const h of headers) {
      const score = scoreHeaderMatch(pick, h, headers);
      if (score > bestScore) {
        bestScore = score;
        bestHeader = h;
      }
    }
    return bestScore > 0 ? bestHeader?.eventId : undefined;
  }

  const rowIdRaw = pick.row || pick.id;
  const rowId = typeof rowIdRaw === 'string' && /^R\d+$/i.test(rowIdRaw.trim()) ? rowIdRaw.trim().toUpperCase() : undefined;
  const rowHeader = rowId
    ? headers.find(h => (h.options || []).some(o => Boolean(o.id) && o.id.toUpperCase() === rowId))
    : undefined;

  const pickText = `${pick.side || ''} ${pick.pick || ''} ${pick.match || ''} ${pick.game || ''} ${pick.team || ''} ${pick.description || ''} ${pick.selection || ''} ${pick.note || ''} ${pick.claim || ''}`.trim();

  // If pick cites a valid row and its side matches that row's header, bind to the row's event first
  if (rowHeader && pickText && scoreHeaderMatch(pickText, rowHeader, headers) >= 60) {
    return rowHeader.eventId;
  }

  if (pick.event_id) return String(pick.event_id);
  if (pick.eventId) return String(pick.eventId);

  if (rowHeader) return rowHeader.eventId;

  if (pickText) {
    let bestHeader: GameHeader | undefined;
    let bestScore = 0;
    for (const h of headers) {
      const score = scoreHeaderMatch(pickText, h, headers);
      if (score > bestScore) {
        bestScore = score;
        bestHeader = h;
      }
    }
    if (bestScore > 0 && bestHeader) return bestHeader.eventId;
  }

  return undefined;
}

/**
 * Filters picks by covered event IDs.
 * Drops any pick whose event_id (or scorecard R-id mapped through GameHeader.options) is not in coveredEventIds.
 */
export function filterPicksByCoverage<T = any>(
  picks: T[],
  coveredEventIds: string[] | Set<string>,
  headers: GameHeader[]
): T[] {
  if (!Array.isArray(picks) || picks.length === 0) return [];
  const coveredSet = coveredEventIds instanceof Set ? coveredEventIds : new Set(coveredEventIds);
  if (coveredSet.size === 0) return [];

  return picks.filter(pick => {
    const eventId = getEventIdForPick(pick, headers);
    return eventId ? coveredSet.has(eventId) : false;
  });
}
