import type { GameHeader } from './gameHeaders.js';
import { matchTeamByLabel, type EspnTeamEntry } from '../tools/injuryAttribution.js';

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildHeaderAliasMap(
  headers: GameHeader[]
): Array<{ eventId: string; rowIds: string[]; nameAliases: string[]; abbrAliases: string[] }> {
  const cityCounts = new Map<string, number>();
  const resolved = headers.map(h => ({
    header: h,
    awayEntry: matchTeamByLabel(h.away, h.sport),
    homeEntry: matchTeamByLabel(h.home, h.sport)
  }));

  for (const r of resolved) {
    for (const e of [r.awayEntry, r.homeEntry]) {
      if (!e) continue;
      const city = e.city.toLowerCase();
      cityCounts.set(city, (cityCounts.get(city) || 0) + 1);
    }
  }

  return resolved
    .filter(r => Boolean(r.header?.eventId))
    .map(({ header, awayEntry, homeEntry }) => {
      const nameAliases = new Set<string>();
      const abbrAliases = new Set<string>();

      const collegeStop = new Set([
        'state', 'tech', 'university', 'college', 'north', 'south', 'east', 'west',
        'central', 'western', 'eastern', 'northern', 'southern', 'golden', 'blue',
        'red', 'green', 'black', 'white', 'crimson', 'city', 'team', 'new', 'san',
        'saint', 'santa', 'los', 'las', 'el', 'la', 'de', 'of', 'the', 'at'
      ]);

      const addTeam = (raw: string, entry?: EspnTeamEntry) => {
        const clean = String(raw || '').trim().toLowerCase();
        if (clean && !/^(away|home|unknown|tbd)$/i.test(clean)) {
          nameAliases.add(clean);
        }
        if (entry) {
          nameAliases.add(entry.name.toLowerCase());
          nameAliases.add(entry.nickname.toLowerCase());
          const cityLower = entry.city.toLowerCase();
          if ((cityCounts.get(cityLower) || 0) <= 1 && cityLower.length >= 4) {
            nameAliases.add(cityLower);
          }
          for (const a of entry.aliases) {
            if (a.length >= 4 && a !== cityLower) {
              nameAliases.add(a.toLowerCase());
            }
          }
          if (entry.abbr && entry.abbr.length >= 2) {
            abbrAliases.add(entry.abbr.toUpperCase());
          }
        } else if (clean && !/^(away|home|unknown|tbd)$/i.test(clean)) {
          const words = clean.split(/\s+/).filter(Boolean);
          if (words.length >= 2) {
            const schoolPhrase = words.slice(0, words.length - 1).join(' ');
            if (schoolPhrase.length >= 4 && !collegeStop.has(schoolPhrase)) {
              nameAliases.add(schoolPhrase);
            }
            const mascot = words[words.length - 1];
            if (mascot.length >= 4 && !collegeStop.has(mascot)) {
              nameAliases.add(mascot);
            }
          }
        }
      };

      addTeam(header.away, awayEntry);
      addTeam(header.home, homeEntry);

      return {
        eventId: header.eventId,
        rowIds: (header.options || []).map(o => o.id.toUpperCase()).filter(Boolean),
        nameAliases: Array.from(nameAliases),
        abbrAliases: Array.from(abbrAliases)
      };
    });
}
