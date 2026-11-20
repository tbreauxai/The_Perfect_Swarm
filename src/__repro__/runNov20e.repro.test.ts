import { describe, it, expect } from 'vitest';
import { parseGameHeaders, renderHeaders } from '../swarm/context/gameHeaders.ts';
import { resolveSelectedGameIds } from '../swarm/context/selectedGames.ts';
import {
    extractRowOptions,
    auditMarketCoverageAndRowBinding
} from '../swarm/tools/marketRowBinding.ts';
import {
    auditPullBeforePass,
    sanitizePullBeforePassClaims
} from '../swarm/tools/pullBeforePass.ts';
import { auditInjuryAttribution } from '../swarm/tools/injuryAttribution.ts';

describe('runNov20e repros (wf-1795209358320)', () => {
    it('G: board R2 collides with synthetic spread option on sp/ml/tot header (pre-fix)', () => {
        const compactLine =
            'event_id=nba-401909306 | Orlando Magic @ Brooklyn Nets | sp 4.5 | ml 165/-190 | tot 220.5';
        const board = [
            compactLine,
            'R2 | nba-401909306 | h2h | Orlando Magic | -190'
        ].join('\n');

        const headers = parseGameHeaders(board);
        const rowMap = extractRowOptions([board], headers);

        expect(rowMap.get('R2')?.text).toBe('Brooklyn Nets +4.5 / Orlando Magic -4.5');

        const audit = auditMarketCoverageAndRowBinding(
            {
                picks: [
                    {
                        row: 'R2',
                        event_id: 'nba-401909306',
                        side: 'Orlando Magic ML'
                    }
                ]
            },
            '[MARKET MOVEMENT: nba-401909306 | all] spread=4.5, ml_home=165, ml_away=-190',
            board,
            headers
        );
        expect(audit.pass).toBe(false);
        expect(renderHeaders(headers)).toContain('R2 ');
    });

    it('H: resolveSelectedGameIds matches synthetic R2 across all 3 games (pre-fix)', () => {
        const slate = [
            'event_id=nba-401909306 | Orlando Magic @ Brooklyn Nets | sp 4.5 | ml 165/-190 | tot 220.5',
            'event_id=nba-401909309 | Washington Wizards @ Chicago Bulls | sp -2.5 | ml -135/115 | tot 218.5',
            'event_id=nba-401909312 | Houston Rockets @ Denver Nuggets | sp -1.5 | ml -122/102 | tot 226.5'
        ].join('\n');
        const headers = parseGameHeaders(slate);
        const proposal = {
            picks: [{ row: 'R2', event_id: 'nba-401909306', side: 'Orlando Magic ML' }]
        };

        const selected = resolveSelectedGameIds(proposal, headers);
        expect(selected).toHaveLength(3);
    });

    it('I: "lack of verified market data" evades auditPullBeforePass when MARKET_MOD lacks verified (pre-fix)', () => {
        const board =
            'event_id=nba-401909306 | sport=nba | Orlando Magic @ Brooklyn Nets | options: R1 Orlando Magic ML (-190)';
        const headers = parseGameHeaders(board);
        const trace: any[] = [
            {
                tool: 'get_market_movement',
                eventId: 'nba-401909306',
                status: 'data',
                summary: 'ml_home=165, ml_away=-190'
            }
        ];
        const proposal = {
            summary: 'Passing on Orlando Magic @ Brooklyn Nets due to lack of verified market data. Holding cash tonight.',
            picks: []
        };

        const audit = auditPullBeforePass(proposal, 'ml_home=165, ml_away=-190', board, {
            headers,
            toolCallTrace: trace
        });
        expect(audit.pass).toBe(true);
        const sanitized = sanitizePullBeforePassClaims({ ...proposal }, 'ml_home=165, ml_away=-190', board, {
            headers,
            toolCallTrace: trace
        });
        expect(sanitized.summary).toContain('lack of verified market data');
    });

    it('J: wrong-team gap phrasing ("Brooklyn\'s frontcourt depth ... Paolo Banchero") evades patA-D (pre-fix)', () => {
        const board =
            'event_id=nba-401909306 | sport=nba | Orlando Magic @ Brooklyn Nets | options: R1 Orlando Magic -4.5 (-110)';
        const injuryEvidence =
            'EVENT nba-401909306 Orlando Magic @ Brooklyn Nets\nINJ: ORL: Paolo Banchero (F): OUT';

        const audit = auditInjuryAttribution(
            {
                summary:
                    "In Orlando Magic @ Brooklyn Nets, Brooklyn's frontcourt depth is depleted with Paolo Banchero sidelined."
            },
            injuryEvidence,
            board
        );
        expect(audit.pass).toBe(true);
    });

    it('K: college-football/college-basketball event_id prefixes truncate to "college" (pre-fix)', () => {
        const cfb = parseGameHeaders(
            'event_id=college-football-401864542 | New Mexico @ Wyoming | sp -3.5 | ml -165/140 | tot 52.5'
        );
        const cbb = parseGameHeaders(
            'event_id=college-basketball-401829310 | Duke @ North Carolina | sp -2.5 | ml -140/120 | tot 148.5'
        );
        expect(cfb[0].sport).toBe('college');
        expect(cbb[0].sport).toBe('college');
    });
});
