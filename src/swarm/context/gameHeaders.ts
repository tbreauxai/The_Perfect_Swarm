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
  options: GameHeaderOption[];
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
    const rawOpts = segment.replace(/^options:\s*/i, '').trim();
    // Options format: "R1 KC -3.5 (-110), R2 BUF +3.5 (-110)" or semicolon delimited
    const optItems = rawOpts.split(/[,;]\s*(?=R\d+)/);
    for (const item of optItems) {
      const match = item.trim().match(/^(R\d+)\s*(.*)$/);
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
          } else if (p.includes('@')) {
            const teams = p.split('@').map(t => t.trim());
            if (teams.length === 2 && teams[0] && teams[1]) {
              away = teams[0];
              home = teams[1];
            }
          } else if (p.toLowerCase().startsWith('options:')) {
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
            const prefixMatch = eventId.match(/^([a-z][a-z0-9_]*)-/i);
            if (prefixMatch) {
              sport = prefixMatch[1].toLowerCase();
            }
          }
          if (mlRaw && !/^n\/a$/i.test(mlRaw)) {
            const mlParts = mlRaw.split('/').map(s => s.trim());
            if (mlParts.length === 2 && mlParts[0] && mlParts[1] && !/^n\/a$/i.test(mlParts[0]) && !/^n\/a$/i.test(mlParts[1])) {
              options.push({
                id: '',
                text: `${away} ML ${mlParts[1]} / ${home} ML ${mlParts[0]}`
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
          headers.push({ eventId, sport, away, home, commence, options });
        }
      } else if (line.includes('|') && line.includes('@')) {
        const parts = line.split('|').map(p => p.trim());
        if (parts.length >= 2 && /^[a-z][a-z0-9_-]*-\d+$/i.test(parts[0])) {
          const eventId = parts[0];
          const prefixMatch = eventId.match(/^([a-z][a-z0-9_]*)-/i);
          let sport = prefixMatch ? prefixMatch[1].toLowerCase() : 'unknown';
          let away = 'Away';
          let home = 'Home';
          let commence: string | undefined = undefined;
          const options: GameHeaderOption[] = [];
          let foundMatchup = false;

          for (const p of parts.slice(1)) {
            if (p.startsWith('sport=')) {
              const explicitSport = p.replace('sport=', '').trim();
              if (explicitSport && !/^unknown$/i.test(explicitSport)) {
                sport = explicitSport;
              }
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
            } else if (p.toLowerCase().startsWith('options:')) {
              parseOptionsSegment(p, options);
            }
          }

          if (foundMatchup) {
            headers.push({ eventId, sport, away, home, commence, options });
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
    return `event_id=${h.eventId} | ${h.sport} | ${h.away} @ ${h.home}${commenceStr}${optsStr}`;
  };

  for (let maxOpts = 6; maxOpts >= 1; maxOpts--) {
    const lines = headers.map(h => formatLine(h, maxOpts));
    const fullText = lines.join('\n');
    if (fullText.length <= maxChars) {
      return fullText;
    }
  }

  const baseLines = headers.map(h => formatLine(h, 0));
  if (baseLines.join('\n').length <= maxChars) {
    return baseLines.join('\n');
  }

  return baseLines.join('\n').slice(0, maxChars);
}

/**
 * Maps a pick object (or string) to its corresponding event ID using parsed game headers.
 */
export function getEventIdForPick(pick: any, headers: GameHeader[]): string | undefined {
  if (!pick) return undefined;
  if (typeof pick === 'string') {
    const clean = pick.toUpperCase();
    for (const h of headers) {
      if (h.eventId && clean.includes(h.eventId.toUpperCase())) return h.eventId;
      if (h.away && h.home && clean.includes(`${h.away.toUpperCase()}@${h.home.toUpperCase()}`)) return h.eventId;
      if (h.away && clean.includes(h.away.toUpperCase())) return h.eventId;
      if (h.home && clean.includes(h.home.toUpperCase())) return h.eventId;
    }
    return undefined;
  }

  if (pick.event_id) return String(pick.event_id);
  if (pick.eventId) return String(pick.eventId);

  const rowId = pick.row || pick.id;
  if (typeof rowId === 'string' && rowId.trim()) {
    const matchingHeader = headers.find(h => (h.options || []).some(o => Boolean(o.id) && o.id === rowId));
    if (matchingHeader) return matchingHeader.eventId;
  }

  const pickText = `${pick.match || ''} ${pick.game || ''} ${pick.team || ''} ${pick.description || ''} ${pick.selection || ''} ${pick.note || ''} ${pick.claim || ''}`.toUpperCase();
  for (const h of headers) {
    if (h.eventId && pickText.includes(h.eventId.toUpperCase())) {
      return h.eventId;
    }
    if (h.away && h.home && pickText.includes(`${h.away.toUpperCase()}@${h.home.toUpperCase()}`)) {
      return h.eventId;
    }
    if (h.away && h.home && (pickText.includes(h.away.toUpperCase()) || pickText.includes(h.home.toUpperCase()))) {
      return h.eventId;
    }
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
