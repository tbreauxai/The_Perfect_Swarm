import { describe, it, expect } from 'vitest';
import {
    auditPullBeforePass,
    buildToolPullLedger,
    isBoardRowId,
    isValidCanonicalGameId,
    mergeToolCallTraceEntries,
    sanitizePullBeforePassClaims
} from '../swarm/tools/pullBeforePass.ts';
import type { GameHeader } from '../swarm/context/gameHeaders.ts';

describe('wf-1795321520065 P2-1: Guard PULL BEFORE PASS Validator Against R# Row IDs & Empty Slates', () => {
    it('identifies R# board row IDs and excludes them from tool pull ledgers and trace merging', () => {
        expect(isBoardRowId('R1')).toBe(true);
        expect(isBoardRowId('r42')).toBe(true);
        expect(isBoardRowId('nba-401910001')).toBe(false);

        expect(isValidCanonicalGameId('R1')).toBe(false);
        expect(isValidCanonicalGameId('unknown-game')).toBe(false);
        expect(isValidCanonicalGameId('nba-401910001')).toBe(true);

        const merged = mergeToolCallTraceEntries([
            { tool: 'get_market_movement', eventId: 'R1', status: 'error', summary: 'no canonical game for R1' },
            { tool: 'get_market_movement', eventId: 'nba-401910001', status: 'data', summary: 'BOS -4.5 (-110)' }
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0].eventId).toBe('nba-401910001');

        const ledger = buildToolPullLedger(
            'Error fetching market movement for R1: not found\n[MARKET MOVEMENT: R2 | 0 snapshots]',
            {
                toolCallTrace: [
                    { tool: 'get_market_movement', eventId: 'R1', status: 'error' },
                    { tool: 'get_market_movement', eventId: 'R12', status: 'empty' }
                ]
            }
        );
        expect(ledger.eventIdsSeen.has('R1')).toBe(false);
        expect(ledger.eventIdsSeen.has('R2')).toBe(false);
        expect(ledger.eventIdsSeen.has('R12')).toBe(false);
        expect(ledger.eventIdsSeen.size).toBe(0);
    });

    it('never triggers Veto (PULL BEFORE PASS) for "R1" when an LLM calls a tool or claims missing fundamentals on R1', () => {
        const proposal = {
            pass: false,
            picks: [],
            summary: 'Claimed matchup fundamentals missing/not fetched for R1.',
            analysis: 'No matchup fundamentals were available for R1 after get_market_movement("R1") returned empty.'
        };
        const evidence = 'Error fetching market movement for R1: no canonical game for R1';

        const audit = auditPullBeforePass(proposal, evidence, '=== COMPACT SLATE ===\nNo upcoming games: 78 started games omitted.', {
            toolCallTrace: [
                { tool: 'get_market_movement', eventId: 'R1', status: 'error', summary: 'no canonical game for R1' }
            ],
            availableTools: ['get_matchup_fundamentals', 'get_injury_and_roster_delta', 'get_market_movement']
        });

        expect(audit.pass).toBe(true);
        expect(audit.violations).toEqual([]);
        expect(audit.flags).toEqual([]);
        expect(audit.unqueriedGameIds).toEqual([]);
        expect(audit.feedback).toBeUndefined();
    });

    it('never emits unqueried_missing_data_claim when activeEventIds is empty []', () => {
        const proposal = {
            picks: [],
            summary: 'Matchup fundamentals are missing and market movement was not fetched across tonight slate.'
        };
        const evidence = '[MARKET MOVEMENT: R1 | 0 snapshots]';

        const audit = auditPullBeforePass(proposal, evidence, '=== COMPACT SLATE ===\nNo upcoming games: 78 started games omitted.', {
            activeEventIds: [],
            toolCallTrace: [
                { tool: 'get_market_movement', eventId: 'R1', status: 'error' }
            ],
            availableTools: ['get_matchup_fundamentals', 'get_injury_and_roster_delta', 'get_market_movement']
        });

        expect(audit.pass).toBe(true);
        expect(audit.flags).not.toContain('unqueried_missing_data_claim');
        expect(audit.violations).toEqual([]);
        expect(audit.unqueriedGameIds).toEqual([]);

        const clone = { ...proposal };
        const sanitized = sanitizePullBeforePassClaims(clone, evidence, undefined, { activeEventIds: [] });
        expect(sanitized.summary).toBe(proposal.summary);
    });

    it('intersects with valid canonical activeEventIds while filtering out R# IDs and non-active games', () => {
        const headers: GameHeader[] = [
            {
                eventId: 'nba-401910001',
                away: 'Miami Heat',
                home: 'Boston Celtics',
                sport: 'basketball_nba',
                options: [{ id: 'R1', text: 'R1 Boston Celtics -4.5 ML -180' }]
            },
            {
                eventId: 'ncaaf-999999',
                away: 'Started Away',
                home: 'Started Home',
                sport: 'americanfootball_ncaaf',
                options: [{ id: 'R2', text: 'R2 Started Home -3.5 ML -150' }]
            }
        ];

        const proposal = {
            summary: 'Miami Heat @ Boston Celtics fundamentals are missing so passing tonight.'
        };

        // Even though ncaaf-999999 was started/unqueried and R1 was in the trace,
        // activeEventIds scopes strictly to canonical nba-401910001
        const audit = auditPullBeforePass(proposal, 'ML -180', '', {
            headers,
            activeEventIds: ['R1', 'nba-401910001'],
            toolCallTrace: [
                { tool: 'get_market_movement', eventId: 'R1', status: 'error' }
            ],
            availableTools: ['get_matchup_fundamentals', 'get_market_movement']
        });

        expect(audit.pass).toBe(false);
        expect(audit.flags).toContain('unqueried_missing_data_claim');
        expect(audit.unqueriedGameIds).toEqual(['nba-401910001']);
        expect(audit.unqueriedGameIds).not.toContain('R1');
        expect(audit.unqueriedGameIds).not.toContain('ncaaf-999999');
    });
});
