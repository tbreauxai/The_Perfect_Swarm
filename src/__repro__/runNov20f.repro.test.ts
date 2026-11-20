import { describe, it, expect } from 'vitest';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';
import { resolveSelectedGameIds } from '../swarm/context/selectedGames.ts';

describe('runNov20f repros (wf-1795213037531)', () => {
    const SLATE = [
        'event_id=nba-401909306 | Orlando Magic @ Brooklyn Nets | sp 4.5 | ml 165/-190 | tot 220.5',
        'event_id=nba-401909309 | Washington Wizards @ Chicago Bulls | sp -2.5 | ml -135/115 | tot 218.5',
        'event_id=nba-401909312 | Houston Rockets @ Denver Nuggets | sp -1.5 | ml -122/102 | tot 226.5',
        'event_id=college-football-401864542 | New Mexico Lobos @ Wyoming Cowboys | sp -3.5 | ml -165/140 | tot 52.5'
    ].join('\n');

    it('L: resolveSelectedGameIds matches team nameAliases (nickname/city, case-insensitive) in picks when synthetic header options have empty id', () => {
        const headers = parseGameHeaders(SLATE);
        const proposal = {
            picks: [
                { row: 'R2', side: 'Magic ML (-190)', reason: 'Orlando backcourt edge' },
                { row: 'R6', pick: 'nuggets -1.5', reason: 'Denver interior advantage' }
            ]
        };

        const selected = resolveSelectedGameIds(proposal, headers);
        expect(selected).toEqual(['nba-401909306', 'nba-401909312']);
    });

    it('L2: resolveSelectedGameIds matches case-sensitive abbrAliases and college school/mascot aliases in string picks, scorecard, and single pick objects', () => {
        const headers = parseGameHeaders(SLATE);

        const fromStringPick = resolveSelectedGameIds(
            { picks: ['R2 ORL ML (-190)'] },
            headers
        );
        expect(fromStringPick).toEqual(['nba-401909306']);

        const fromScorecard = resolveSelectedGameIds(
            { scorecard: { row: 'R6', pick: 'DEN -1.5 (-110)' } },
            headers
        );
        expect(fromScorecard).toEqual(['nba-401909312']);

        const fromSinglePick = resolveSelectedGameIds(
            { row: 'R8', selection: 'Lobos +3.5 (-110)' },
            headers
        );
        expect(fromSinglePick).toEqual(['college-football-401864542']);

        // Lowercase abbreviation in narrative/pick text must not trigger case-sensitive abbrAliases
        const lowerAbbr = resolveSelectedGameIds(
            { picks: [{ row: 'R2', side: 'orl ml' }] },
            headers
        );
        expect(lowerAbbr).toEqual([]);
    });

    it('L3: resolveSelectedGameIds enables aliases only on pick text (L42/L67/L80/L91) and not on the L95-104 narrative fallback', () => {
        const headers = parseGameHeaders(SLATE);

        // Pick uses nickname alias "Magic", while summary mentions other slate teams by nickname ("Bulls", "Nuggets", "Cowboys")
        const pickedWithNarrative = resolveSelectedGameIds(
            {
                picks: [{ row: 'R2', side: 'Magic -4.5' }],
                summary: 'Taking Magic -4.5; passing on Bulls, Nuggets, and Cowboys tonight.',
                analysis: 'Wizards and Rockets lack value.'
            },
            headers
        );
        expect(pickedWithNarrative).toEqual(['nba-401909306']);

        // Narrative-only report mentioning aliases without picks must not match aliases in fallbackText
        const narrativeOnlyAliases = resolveSelectedGameIds(
            {
                summary: 'Passing on Magic, Bulls, Nuggets, and Cowboys tonight.',
                analysis: 'Holding cash across ORL, CHI, and DEN.'
            },
            headers
        );
        expect(narrativeOnlyAliases).toEqual([]);
    });
});
