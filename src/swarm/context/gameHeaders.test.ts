import { describe, it, expect } from 'vitest';
import { parseGameHeaders, renderHeaders, type GameHeader } from './gameHeaders.ts';

describe('Game Headers Context & Parsing', () => {
  it('parses DuelOdds compact-slate lines and extracts event IDs and options', () => {
    const compactInput = `
event_id=nfl-401547632 | sport=football_nfl | KC @ BUF | commence=2026-11-15T18:00:00Z | options: R1 KC -3.5 (-110), R2 BUF +3.5 (-110), R3 Over 48.5 (-110)
event_id=nba-401584793 | sport=basketball_nba | BOS @ MIA | options: R4 BOS -6.5 (-110), R5 MIA +6.5 (-110)
`;
    const headers = parseGameHeaders(compactInput);
    expect(headers).toHaveLength(2);

    expect(headers[0].eventId).toBe('nfl-401547632');
    expect(headers[0].sport).toBe('football_nfl');
    expect(headers[0].away).toBe('KC');
    expect(headers[0].home).toBe('BUF');
    expect(headers[0].options).toHaveLength(3);
    expect(headers[0].options[0]).toEqual({ id: 'R1', text: 'KC -3.5 (-110)' });

    expect(headers[1].eventId).toBe('nba-401584793');
    expect(headers[1].away).toBe('BOS');
    expect(headers[1].home).toBe('MIA');
    expect(headers[1].options).toHaveLength(2);
  });

  it('completely ignores raw board tables and Markdown grids ("id|game|market")', () => {
    const rawTableInput = `
| id | game | market | line | price |
| --- | --- | --- | --- | --- |
| 1 | KC @ BUF | spread | -3.5 | -110 |
| 2 | BOS @ MIA | total | 215.5 | -110 |
RAW ACTIONABLE BETS:
id|game|market|line
1|KC @ BUF|spread|-3.5
`;
    const headers = parseGameHeaders(rawTableInput);
    expect(headers).toHaveLength(0);
  });

  it('falls back to params.eventIds when no compact-slate lines are found', () => {
    const headers = parseGameHeaders('Some random task description', ['nfl-401547632', 'nba-401584793']);
    expect(headers).toHaveLength(2);
    expect(headers[0].eventId).toBe('nfl-401547632');
    expect(headers[0].away).toBe('Away');
    expect(headers[0].home).toBe('Home');
  });

  it('renders a 10-game slate within 1600 characters', () => {
    const sampleHeaders: GameHeader[] = Array.from({ length: 10 }, (_, i) => ({
      eventId: `nfl-${400000000 + i}`,
      sport: 'football_nfl',
      away: `AWAY${i}`,
      home: `HOME${i}`,
      commence: '2026-11-15T18:00:00Z',
      options: [
        { id: `R${i * 4 + 1}`, text: `AWAY${i} +3.5 (-110)` },
        { id: `R${i * 4 + 2}`, text: `HOME${i} -3.5 (-110)` },
        { id: `R${i * 4 + 3}`, text: `Over 45.5 (-110)` },
        { id: `R${i * 4 + 4}`, text: `Under 45.5 (-110)` }
      ]
    }));

    const rendered = renderHeaders(sampleHeaders, 1600);
    expect(rendered.split('\n')).toHaveLength(10);
    expect(rendered.length).toBeLessThanOrEqual(1600);
    expect(rendered).toContain('event_id=nfl-400000000 | football_nfl | AWAY0 @ HOME0');
    expect(rendered).toContain('options: R1 AWAY0 +3.5 (-110)');
  });
});
