import { describe, it, expect } from 'vitest';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';
import {
    extractRowOptions,
    isFalseMissingMoneylineCritique,
    auditMarketCoverageAndRowBinding
} from '../swarm/tools/marketRowBinding.ts';
import { auditPullBeforePass } from '../swarm/tools/pullBeforePass.ts';
import { auditInjuryAttribution } from '../swarm/tools/injuryAttribution.ts';

describe('runNov20d repros (wf-1795206176838 / wf-1795205597957)', () => {
    it('A: parseGameHeaders parses sp, ml H/A, tot and infers sport from event_id prefix', () => {
        const line = 'event_id=nba-401909312 | Houston Rockets @ Denver Nuggets | sp -1.5 | ml -122/102 | tot 226.5';
        const headers = parseGameHeaders(line);
        expect(headers).toHaveLength(1);
        expect(headers[0].sport).toBe('nba');
        const texts = headers[0].options.map(o => o.text);
        expect(texts).toContain('Houston Rockets ML 102 / Denver Nuggets ML -122');
        expect(texts).toContain('Denver Nuggets -1.5 / Houston Rockets +1.5');
        expect(texts).toContain('O/U 226.5');

        const naLine = 'event_id=ncaaf-401864542 | New Mexico @ Wyoming | sp n/a | ml n/a/n/a | tot n/a';
        const naHeaders = parseGameHeaders(naLine);
        expect(naHeaders[0].sport).toBe('ncaaf');
        expect(naHeaders[0].options).toHaveLength(0);
    });

    it('B: extractRowOptions sets eventId from cells[1] when pipe row has event_id in cell 1', () => {
        const board = 'R2 | nba-401909306 | Orlando Magic @ Brooklyn Nets | Orlando Magic +5.5 (-110)';
        const rowMap = extractRowOptions([board]);
        const r2 = rowMap.get('R2');
        expect(r2).toBeDefined();
        expect(r2?.eventId).toBe('nba-401909306');
    });

    it('C: isFalseMissingMoneylineCritique matches "lacks verified market data" / "no market pricing"', () => {
        const board = 'event_id=nba-401909306 | sport=nba | Orlando Magic @ Brooklyn Nets | options: R1 Orlando Magic ML (-110)';
        const headers = parseGameHeaders(board);
        const proposal = {
            picks: [{ row: 'R1', event_id: 'nba-401909306', side: 'Orlando Magic ML' }]
        };
        const toolEvidence = '[MARKET MOVEMENT: nba-401909306 | all] ml_home=205, ml_away=-240, spread=6.5';
        expect(
            isFalseMissingMoneylineCritique(
                'Proposal lacks verified market data for Orlando Magic ML.',
                proposal,
                toolEvidence,
                board,
                headers
            )
        ).toBe(true);
        expect(
            isFalseMissingMoneylineCritique(
                'No market pricing available for Orlando Magic ML.',
                proposal,
                toolEvidence,
                board,
                headers
            )
        ).toBe(true);
    });

    it('D: auditPullBeforePass flags "lack(s/ing) of market/fundamentals/injury data" when tools returned data', () => {
        const board = 'event_id=nba-401909312 | sport=nba | Houston Rockets @ Denver Nuggets | options: R1 Denver Nuggets -1.5 (-110)';
        const headers = parseGameHeaders(board);
        const trace: any[] = [
            { tool: 'get_market_movement', gameId: 'nba-401909312', status: 'data', summary: 'spread=-1.5' },
            { tool: 'get_matchup_fundamentals', gameId: 'nba-401909312', status: 'data', summary: 'form ok' },
            { tool: 'get_injury_and_roster_delta', gameId: 'nba-401909312', status: 'data', summary: 'injuries ok' }
        ];
        const res = auditPullBeforePass(
            { summary: 'Denver Nuggets @ Houston Rockets lacks of market data and lack of fundamentals data.' },
            trace,
            headers
        );
        expect(res.pass).toBe(false);
    });

    it('E: auditInjuryAttribution catches wrong-team attribution using frontcourt/backcourt/rotation/lineup/depth/bench', () => {
        const board = 'event_id=nba-401909306 | sport=nba | Orlando Magic @ Brooklyn Nets | options: R1 Orlando Magic -5.5 (-110)';
        const injuryEvidence = 'EVENT nba-401909306 Orlando Magic @ Brooklyn Nets\nINJ: ORL: Paolo Banchero (F): OUT';
        const res = auditInjuryAttribution(
            { summary: "In Orlando Magic vs Brooklyn Nets, Brooklyn Nets's frontcourt rotation Paolo Banchero is sidelined." },
            injuryEvidence,
            board
        );
        expect(res.pass).toBe(false);
    });

    it('F: sp/ml/tot header + home/away role check vetoes "Houston are home favorites"', () => {
        const line = 'event_id=nba-401909312 | Houston Rockets @ Denver Nuggets | sp -1.5 | ml -122/102 | tot 226.5';
        const headers = parseGameHeaders(line);
        const res = auditMarketCoverageAndRowBinding(
            {
                summary: 'Houston are home favorites in this matchup.',
                picks: [{ row: 'R1', event_id: 'nba-401909312', side: 'Houston Rockets +1.5' }]
            },
            '[MARKET MOVEMENT: nba-401909312 | all] spread=-1.5, ml_home=-122, ml_away=102',
            line,
            { headers }
        );
        expect(res.pass).toBe(false);
    });
});
