import { describe, it, expect } from 'vitest';
import { resolveSelectedGameIds, filterHeadersByEventIds } from './selectedGames.ts';
import type { GameHeader } from './gameHeaders.ts';

describe('Selected Game Resolver (Goal 1)', () => {
  const headers: GameHeader[] = [
    { eventId: 'nba-lal', sport: 'nba', away: 'SAS', home: 'Los Angeles Lakers', options: [] },
    { eventId: 'nba-lac', sport: 'nba', away: 'SAC', home: 'Los Angeles Clippers', options: [] },
    { eventId: 'nhl-dal', sport: 'nhl', away: 'MIN', home: 'Dallas Stars', options: [] },
    { eventId: 'nba-unselected', sport: 'nba', away: 'MIA', home: 'Orlando Magic', options: [] }
  ];

  it('extracts unique event_ids from picks, rows, and team names while dropping unselected games', () => {
    const proposal = {
      picks: [
        { event_id: 'nba-lal', selection: 'Los Angeles Lakers -7.5' },
        { row: 'R2', pick: 'Los Angeles Clippers -6.5' },
        { side: 'Dallas Stars ML' }
      ],
      summary: 'Parlay of Lakers, Clippers, Dallas (ignoring Orlando Magic)'
    };

    const selected = resolveSelectedGameIds(proposal, headers);
    expect(selected).toEqual(['nba-lal', 'nba-lac', 'nhl-dal']);
    expect(selected).not.toContain('nba-unselected');

    const filtered = filterHeadersByEventIds(headers, selected);
    expect(filtered.map(h => h.eventId)).toEqual(['nba-lal', 'nba-lac', 'nhl-dal']);
  });

  it('extracts event_ids from scorecard citations and falls back to summary when picks are absent', () => {
    const scorecardReport = { scorecard: { row: 'R3', pick: 'Dallas Stars ML' } };
    const proseProposal = { summary: 'Lean Los Angeles Lakers -7.5' };

    expect(resolveSelectedGameIds([scorecardReport, proseProposal], headers)).toEqual(['nhl-dal', 'nba-lal']);
  });
});
