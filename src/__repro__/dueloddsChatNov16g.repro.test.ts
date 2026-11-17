import { describe, it, expect } from 'vitest';
import { guardAnalystResponse, guardManagerResponse } from '../swarm/parser/responseGuards.ts';
import { partitionTaskAndContract, rankGameIdsBySupabaseEdge } from '../swarm/engine/analystExecution.ts';
import { extractCalibrationPrefix, runDataProfilingPipeline } from '../swarm/engine/profilingPipeline.ts';
import { CRITIC_VERDICT_SYSTEM_INSTRUCTION } from '../swarm/engine/constants.ts';
import { SwarmContext } from '../swarm/context.ts';
import { prependCalibrationToData } from '../swarm/feedback/probabilityCalibration.ts';

describe('DuelOdds Swarm Chat wf-1794874318827 fixes', () => {
    it('1. guardAnalystResponse and guardManagerResponse parse DuelOdds { analysis, picks, scorecards } without marking unparsed output', () => {
        const duelOddsPassOutput = JSON.stringify({
            analysis: 'Slate analysis reveals significant injury decimation across R1-R5, making R7 (Pacers ML) the cleanest spot.',
            picks: [],
            scorecards: [
                { row: 'R7', verdict: 'lean', pick: 'Pacers ML', edge: 'P(Home) 73.4% vs market', risk: 'Road B2B for CLE' }
            ]
        });

        const quantGuarded = guardAnalystResponse(duelOddsPassOutput, 'Quant Proposer');
        expect(quantGuarded._placeholder).toBeUndefined();
        expect(quantGuarded.insights[0]).toContain('Slate analysis reveals significant injury decimation');
        expect(quantGuarded.insights[0]).not.toContain('unparsed output');
        expect(quantGuarded.summary).toContain('Slate analysis reveals significant injury decimation');
        expect(quantGuarded.analysis).toContain('Slate analysis reveals significant injury decimation');
        expect(quantGuarded.scorecards).toHaveLength(1);
        expect(quantGuarded.scorecards?.[0]?.row).toBe('R7');

        // Also test bracketed prose salvage when a model starts plain text with [R7]
        const bracketedProse = '[R7] Pacers ML and [R10] Canucks +1.5 offer the strongest two-leg parlay edge on the board.';
        const marketGuarded = guardAnalystResponse(bracketedProse, 'Market Proposer');
        expect(marketGuarded.insights[0]).toContain('[Market Proposer] prose:');
        expect(marketGuarded.insights[0]).not.toContain('unparsed output');

        // Test guardManagerResponse with DuelOdds synthesis JSON
        const managerSynthesisJson = JSON.stringify({
            analysis: 'Bottom-line call: 2-leg parlay on Pacers ML (R7) + Canucks +1.5 (R10).',
            picks: [
                { row: 'R7', game: 'Cavaliers @ Pacers', pick: 'Pacers ML', market: 'ML', confidence: 73, edge: '73.4% model win prob' },
                { row: 'R10', game: 'Lightning @ Canucks', pick: 'Canucks +1.5', market: 'Spread', confidence: 64, edge: 'Home puckline value' }
            ],
            scorecards: [
                { row: 'R7', verdict: 'play', pick: 'Pacers ML', edge: '73.4% P(Home)', risk: 'Low' }
            ]
        });
        const managerGuarded: any = guardManagerResponse(managerSynthesisJson);
        expect(managerGuarded.summary).toContain('Bottom-line call: 2-leg parlay on Pacers ML (R7)');
        expect(managerGuarded.analysis).toContain('Bottom-line call: 2-leg parlay on Pacers ML (R7)');
        expect(managerGuarded.picks).toHaveLength(2);
        expect(managerGuarded.scorecards).toHaveLength(1);
    });

    it('2. partitionTaskAndContract preserves PICK OUTPUT CONTRACT outside <user_task> instead of truncating at 800 chars', () => {
        const fullDuelOddsTask = [
            'You are the DuelOdds Swarm Chat assistant. Answer the user\'s betting question directly, concisely, and actionably using the current slate data.',
            'Recent Conversation:',
            'USER: what\'s a good parlay to place today?',
            'User Question: "what\'s a good parlay to place today?"',
            'X'.repeat(650),
            '',
            'Output one top-level JSON object only (no markdown fences, no prose before or after): {"analysis": string, "picks": Pick[], "scorecards": Scorecard[]}. Never nest that object inside analysis.',
            'REQUIRED RISK CRITIC & CONFIDENCE CALIBRATION:',
            '- For every recommended pick, explicitly run a devil\'s-advocate risk check.',
            'FILTERED DATA TOOL RULE:',
            '- The slate below has been pre-filtered to top candidate rows.',
            'PICK OUTPUT CONTRACT (use this exact shape for every recommended bet):',
            'Each item in "picks" MUST be:',
            '{"game": "Away Team @ Home Team", "pick": "Team ML", "market": "ML" | "Spread" | "Total", "confidence": 50-95, "edge": "1-sentence justification"}',
            'Each slate row has an id (R1..Rn). Cite rows by id in scorecards and picks.'
        ].join('\n');

        expect(fullDuelOddsTask.length).toBeGreaterThan(1200);
        const { userTask, contractBlock } = partitionTaskAndContract(fullDuelOddsTask);
        expect(userTask.length).toBeLessThanOrEqual(800);
        expect(contractBlock).toContain('PICK OUTPUT CONTRACT');
        expect(contractBlock).toContain('FILTERED DATA TOOL RULE:');
        expect(contractBlock).toContain('Each slate row has an id (R1..Rn)');
    });

    it('3. rankGameIdsBySupabaseEdge prioritizes high-edge Supabase judgment games first while preserving order when no judgments exist', () => {
        const slateGames = [
            'nba-401909096', // R1 MEM @ TOR (coin-flip)
            'nba-401909097', // R2 DET @ BOS
            'nba-401909098', // R3 SAC @ ATL
            'nba-401909099', // R4 CHA @ NYK
            'nba-401909100', // R5 ORL @ PHI
            'nba-401909101', // R6 BKN @ MIA
            'nba-401910001'  // R7 CLE @ IND (strong judgment edge)
        ];

        // Without Supabase context, order is strictly unchanged
        expect(rankGameIdsBySupabaseEdge(slateGames, '')).toEqual(slateGames);

        const supabaseContext = [
            '=== LIVE SUPABASE DUELODDS CONTEXT (ON-DEMAND PULL) ===',
            'Recent Morning Swarm Judgments (2):',
            '- [2026-11-16] event_id=nba-401909096: P(Home)=48.3%, ProjMargin=-0.7 | Coin flip',
            '- [2026-11-16] event_id=nba-401910001: P(Home)=73.4%, ProjMargin=7.5 | Strong home edge for IND'
        ].join('\n');

        const ranked = rankGameIdsBySupabaseEdge(slateGames, supabaseContext);
        expect(ranked[0]).toBe('nba-401910001');
        expect(ranked[1]).toBe('nba-401909096');
        expect(ranked).toHaveLength(slateGames.length);
    });

    it('4. extractCalibrationPrefix & runDataProfilingPipeline strip prepended calibration block before sketching slate rows', () => {
        const rawSlate = [
            'R1 | NBA | event_id=nba-401909096 | Grizzlies @ Raptors | ML +110/-130 | Spread +2.5/-2.5 | Total 228.5',
            'R2 | NBA | event_id=nba-401909097 | Pistons @ Celtics | ML +320/-410 | Spread +9.5/-9.5 | Total 224.0',
            'R3 | NBA | event_id=nba-401910001 | Cavaliers @ Pacers | ML +145/-175 | Spread +4.0/-4.0 | Total 234.5',
            'R4 | NHL | event_id=nhl-401909242 | Lightning @ Canucks | ML -135/+114 | Spread -1.5/+1.5 | Total 6.5'
        ].join('\n');

        const calibratedPayload = prependCalibrationToData(rawSlate, 'duelodds');
        expect(calibratedPayload.startsWith('=== SWARM EMPIRICAL WIN CALIBRATION ===')).toBe(true);

        const { calibrationBlock, cleanPayload } = extractCalibrationPrefix(calibratedPayload);
        expect(calibrationBlock).toContain('=== SWARM EMPIRICAL WIN CALIBRATION ===');
        expect(cleanPayload.startsWith('R1 | NBA')).toBe(true);

        const ctx = new SwarmContext();
        const prof = runDataProfilingPipeline({
            task: 'what is a good parlay today?',
            data: calibratedPayload,
            analysts: [],
            optimizationEnabled: true,
            coordinationEnabled: false,
            context: ctx
        });

        expect(prof.extractedCalibrationBlock).toContain('=== SWARM EMPIRICAL WIN CALIBRATION ===');
        expect(prof.rawInput).not.toContain('=== SWARM EMPIRICAL WIN CALIBRATION ===');
        expect(prof.rawInput).toContain('R1 | NBA');
    });

    it('5. CRITIC_VERDICT_SYSTEM_INSTRUCTION scopes vetoes strictly to proposed pick legs', () => {
        expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain('proposed picks');
        expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain('VETO POLICY');
        expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).not.toContain('Never propose');
    });
});
