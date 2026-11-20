import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { SwarmContext } from '../swarm/context.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { GameQueryCache } from '../swarm/cache/gameQueryCache.ts';
import { auditPullBeforePass } from '../swarm/tools/pullBeforePass.ts';
import { compileSynthesisPrompt } from '../swarm/engine/synthesisPipeline.ts';
import { executeOpenAiCompatibleChat } from '../swarm/providers/baseOpenAi.ts';
import { getInjuryAndRosterDeltaTool } from '../swarm/tools/dueloddsRpcTools.ts';

const SLATE_3_GAMES = [
    'event_id=nba-401909306 | sport=basketball_nba | Orlando Magic @ Brooklyn Nets | commence=2026-11-20T23:30:00Z | options: R1 Orlando Magic ML (-110), R4 Brooklyn Nets ML (-110)',
    'event_id=nba-401909309 | sport=basketball_nba | Washington Wizards @ Chicago Bulls | commence=2026-11-21T00:00:00Z | options: R2 Chicago Bulls ML (-135), R5 Washington Wizards ML (+115)',
    'event_id=nba-401909312 | sport=basketball_nba | Houston Rockets @ Denver Nuggets | commence=2026-11-21T02:00:00Z | options: R3 Denver Nuggets ML (-122), R6 Houston Rockets ML (+102)'
].join('\n');

function makeAgent(role: string, provider: string, runImpl: (prompt: string) => Promise<string> | string): any {
    return {
        role,
        provider,
        modelName: `${provider}-mock`,
        setSystemInstruction: vi.fn(),
        run: vi.fn(async (prompt: string) => runImpl(prompt))
    };
}

function makeToolSpies() {
    const calledByTool: Record<string, string[]> = {
        get_market_movement: [],
        get_injury_and_roster_delta: [],
        get_matchup_fundamentals: [],
        get_environment_and_weather: []
    };
    const mk = (name: keyof typeof calledByTool) => ({
        name,
        description: name,
        parameters: {
            game_id: { type: 'string' as const, description: 'id', required: true },
            market_type: { type: 'string' as const, description: 'market' }
        },
        execute: vi.fn(async ({ game_id }: any) => {
            calledByTool[name].push(game_id);
            if (name === 'get_market_movement') {
                return {
                    success: true,
                    summary: `[MARKET MOVEMENT: ${game_id}] ml_home: -110 | ml_away: -110 | spread: -1.5`,
                    data: { ml_home: -110, ml_away: -110, spread: -1.5 }
                };
            }
            if (name === 'get_injury_and_roster_delta') {
                return {
                    success: true,
                    summary: `[INJURY & ROSTER DELTA: ${game_id}] No significant roster deltas or injury tags reported.`
                };
            }
            if (name === 'get_matchup_fundamentals') {
                return {
                    success: true,
                    summary: `[MATCHUP FUNDAMENTALS: ${game_id} (L10)] Home: W-L 6-4 | Away: W-L 5-5`
                };
            }
            return {
                success: true,
                summary: `[ENVIRONMENT: ${game_id}] Indoor arena.`
            };
        })
    });
    const tools = [
        mk('get_market_movement'),
        mk('get_injury_and_roster_delta'),
        mk('get_matchup_fundamentals'),
        mk('get_environment_and_weather')
    ];
    return {
        calledByTool,
        tools,
        registry: new ToolRegistry(tools)
    };
}

describe('runNov20c repros (wf-1795203442644)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('1a: discussed scoping gone — 0-pick pass runs 0 critic pulls; 1-pick pulls only picked event_id', async () => {
        // Subcase A: 0 picks while prose discusses all 3 games -> 0 critic tool pulls
        const spySetA = makeToolSpies();
        const proposerA = makeAgent('Manager Node', 'gemini', () =>
            JSON.stringify({
                ui_title: 'Slate Review',
                summary:
                    'Slate review covering Orlando Magic @ Brooklyn Nets, Washington Wizards @ Chicago Bulls, and Houston Rockets @ Denver Nuggets.',
                picks: []
            })
        );
        const criticA = makeAgent('Risk Critic', 'groq', () =>
            JSON.stringify({ pass: true, feedback: 'Valid pass.' })
        );

        const resA = await new AnalysisLifecycle(proposerA, criticA, 2, {
            toolRegistry: spySetA.registry,
            queryCache: new GameQueryCache()
        }).executeAndVerify(
            { rawBoard: SLATE_3_GAMES, fullBoard: SLATE_3_GAMES },
            new SwarmContext(),
            'Find best bets or pass.',
            'Verify proposal.'
        );

        expect(resA.success).toBe(true);
        for (const t of spySetA.tools) {
            expect(t.execute).toHaveBeenCalledTimes(0);
        }

        // Subcase B: 1 pick (nba-401909306) while summary mentions Washington Wizards & Denver Nuggets -> pull only nba-401909306
        const spySetB = makeToolSpies();
        const proposerB = makeAgent('Manager Node', 'gemini', () =>
            JSON.stringify({
                ui_title: 'Single Pick',
                summary:
                    'Back Orlando Magic ML (R1). Passing on Washington Wizards and Denver Nuggets tonight.',
                picks: [{ row: 'R1', event_id: 'nba-401909306', side: 'Orlando Magic ML', reason: 'Orlando market value.' }]
            })
        );
        const criticB = makeAgent('Risk Critic', 'groq', () =>
            JSON.stringify({ pass: true, feedback: 'Verified Orlando Magic ML.' })
        );

        const resB = await new AnalysisLifecycle(proposerB, criticB, 2, {
            toolRegistry: spySetB.registry,
            queryCache: new GameQueryCache()
        }).executeAndVerify(
            { rawBoard: SLATE_3_GAMES, fullBoard: SLATE_3_GAMES },
            new SwarmContext(),
            'Find best bets.',
            'Verify proposal.'
        );

        expect(resB.success).toBe(true);
        const allPulledIds = new Set(Object.values(spySetB.calledByTool).flat());
        expect(allPulledIds).toEqual(new Set(['nba-401909306']));
        expect(allPulledIds.has('nba-401909309')).toBe(false);
        expect(allPulledIds.has('nba-401909312')).toBe(false);
    });

    it('1b: empty picks pass:true — skip Check C and lifecycle top-up pulls', async () => {
        // Subcase A: direct auditPullBeforePass returns pass: true on empty picks pass with no tool trace
        const audit = auditPullBeforePass(
            {
                ui_title: 'Pass',
                summary: 'Passing on tonight slate; no actionable edge.',
                picks: []
            },
            '',
            SLATE_3_GAMES,
            {
                availableTools: ['get_matchup_fundamentals', 'get_injury_and_roster_delta', 'get_market_movement']
            }
        );
        expect(audit.pass).toBe(true);

        // Subcase B: AnalysisLifecycle passes on Attempt 1 without PULL BEFORE PASS veto or top-up pulls
        const spySet = makeToolSpies();
        const proposer = makeAgent('Manager Node', 'gemini', () =>
            JSON.stringify({
                ui_title: 'Pass',
                summary: 'Passing on tonight slate; no actionable edge.',
                picks: []
            })
        );
        const critic = makeAgent('Risk Critic', 'groq', () =>
            JSON.stringify({ pass: true, feedback: 'Valid pass.' })
        );

        const res = await new AnalysisLifecycle(proposer, critic, 2, {
            toolRegistry: spySet.registry,
            queryCache: new GameQueryCache()
        }).executeAndVerify(
            { rawBoard: SLATE_3_GAMES, fullBoard: SLATE_3_GAMES },
            new SwarmContext(),
            'Build 3-leg parlay or pass.',
            'Verify proposal.'
        );

        expect(res.success).toBe(true);
        expect(res.attempts).toBe(1);
        expect(res.criticFeedback || '').not.toContain('PULL BEFORE PASS');
        for (const t of spySet.tools) {
            expect(t.execute).toHaveBeenCalledTimes(0);
        }
    });

    it('2: no injury veto when picks=[] or no vetoedLeg matches a pick; veto only on picks[].reason', async () => {
        const evidence =
            'EVENT nba-401909306 Orlando Magic @ Brooklyn Nets\nINJ: Brooklyn Nets (BKN): Cam Thomas (G): OUT';

        // Subcase A: picks: [] with misattributed injury in summary -> sanitize prose, keep pass=true
        const proposerA = makeAgent('Manager Node', 'gemini', () =>
            JSON.stringify({
                ui_title: 'Pass',
                summary: 'Passing on tonight slate. Orlando Magic missing Cam Thomas creates too much uncertainty.',
                picks: []
            })
        );
        const criticA = makeAgent('Risk Critic', 'groq', () =>
            JSON.stringify({ pass: true, feedback: 'Valid pass.' })
        );

        const resA = await new AnalysisLifecycle(proposerA, criticA, 2).executeAndVerify(
            { rawBoard: SLATE_3_GAMES, fullBoard: SLATE_3_GAMES, toolResults: evidence },
            new SwarmContext(),
            'Evaluate slate.',
            'Verify proposal.'
        );

        expect(resA.success).toBe(true);
        expect(resA.attempts).toBe(1);
        expect(resA.finalProposal.summary).not.toMatch(/Orlando Magic missing Cam Thomas/i);

        // Subcase B: valid pick + unrelated prose misattribution -> keep pick & pass, sanitize prose
        const proposerB = makeAgent('Manager Node', 'gemini', () =>
            JSON.stringify({
                ui_title: 'Bulls ML',
                summary: 'Back R2 Chicago Bulls ML. Orlando Magic missing Cam Thomas is notable.',
                picks: [
                    {
                        row: 'R2',
                        event_id: 'nba-401909309',
                        side: 'Chicago Bulls ML',
                        reason: 'Bulls home form edge.'
                    }
                ]
            })
        );
        const criticB = makeAgent('Risk Critic', 'groq', () =>
            JSON.stringify({ pass: true, feedback: 'Verified R2 Chicago Bulls ML.' })
        );

        const resB = await new AnalysisLifecycle(proposerB, criticB, 2).executeAndVerify(
            { rawBoard: SLATE_3_GAMES, fullBoard: SLATE_3_GAMES, toolResults: evidence },
            new SwarmContext(),
            'Evaluate slate.',
            'Verify proposal.'
        );

        expect(resB.success).toBe(true);
        expect(resB.finalProposal.picks).toHaveLength(1);
        expect(resB.finalProposal.picks[0].row).toBe('R2');
        expect(resB.finalProposal.summary).not.toMatch(/Orlando Magic missing Cam Thomas/i);

        // Subcase C: misattribution inside picks[0].reason -> MUST veto
        const proposerC = makeAgent('Manager Node', 'gemini', () =>
            JSON.stringify({
                ui_title: 'Nets ML',
                summary: 'Backing Brooklyn Nets ML (R4).',
                picks: [
                    {
                        row: 'R4',
                        event_id: 'nba-401909306',
                        side: 'Brooklyn Nets ML',
                        reason: 'Orlando Magic missing Cam Thomas.'
                    }
                ]
            })
        );
        const criticC = makeAgent('Risk Critic', 'groq', () =>
            JSON.stringify({ pass: true, feedback: 'Looks fine.' })
        );

        const resC = await new AnalysisLifecycle(proposerC, criticC, 1).executeAndVerify(
            { rawBoard: SLATE_3_GAMES, fullBoard: SLATE_3_GAMES, toolResults: evidence },
            new SwarmContext(),
            'Evaluate slate.',
            'Verify proposal.'
        );

        expect(resC.success).toBe(false);
        expect(resC.criticFeedback).toContain('INJURY ATTRIBUTION RULE');
    });

    it('S4: limits critic tool pulls to max 4 in flight and skips duplicate pre-passed non-empty items', async () => {
        // Subcase A: 3 picked games x 4 tools = 12 pulls -> max 4 in flight
        let inFlight = 0;
        let maxInFlight = 0;
        const toolNames = [
            'get_market_movement',
            'get_injury_and_roster_delta',
            'get_matchup_fundamentals',
            'get_environment_and_weather'
        ] as const;
        const delayTools = toolNames.map(name => ({
            name,
            description: name,
            parameters: {
                game_id: { type: 'string' as const, description: 'id', required: true },
                market_type: { type: 'string' as const, description: 'm' }
            },
            execute: vi.fn(async ({ game_id }: any) => {
                inFlight++;
                if (inFlight > maxInFlight) maxInFlight = inFlight;
                await new Promise(r => setTimeout(r, 25));
                inFlight--;
                if (name === 'get_market_movement') {
                    return {
                        success: true,
                        summary: `[MARKET MOVEMENT: ${game_id}] ml_home: -110 | ml_away: -110 | spread: -1.5`,
                        data: { ml_home: -110, ml_away: -110, spread: -1.5 }
                    };
                }
                return { success: true, summary: `[${name}: ${game_id}] ok` };
            })
        }));

        const proposerA = makeAgent('Manager Node', 'gemini', () =>
            JSON.stringify({
                ui_title: '3-Leg Parlay',
                summary: 'Backing R1, R2, and R3.',
                picks: [
                    { row: 'R1', event_id: 'nba-401909306', side: 'Orlando Magic ML', reason: 'Magic ML.' },
                    { row: 'R2', event_id: 'nba-401909309', side: 'Chicago Bulls ML', reason: 'Bulls ML.' },
                    { row: 'R3', event_id: 'nba-401909312', side: 'Denver Nuggets ML', reason: 'Nuggets ML.' }
                ]
            })
        );
        const criticA = makeAgent('Risk Critic', 'groq', () =>
            JSON.stringify({ pass: true, feedback: 'Verified 3 legs.' })
        );

        const resA = await new AnalysisLifecycle(proposerA, criticA, 1, {
            toolRegistry: new ToolRegistry(delayTools),
            queryCache: new GameQueryCache()
        }).executeAndVerify(
            { rawBoard: SLATE_3_GAMES, fullBoard: SLATE_3_GAMES },
            new SwarmContext(),
            'Build 3-leg parlay.',
            'Verify proposal.'
        );

        expect(resA.success).toBe(true);
        expect(maxInFlight).toBeLessThanOrEqual(4);
        expect(maxInFlight).toBeGreaterThan(1);
        for (const t of delayTools) {
            expect(t.execute).toHaveBeenCalledTimes(3);
        }

        // Subcase B: skips (tool, gId) already in prePassedToolItems with non-empty data, but still pulls empty/error/missing
        const calledPairs: string[] = [];
        const trackedTools = toolNames.map(name => ({
            name,
            description: name,
            parameters: {
                game_id: { type: 'string' as const, description: 'id', required: true },
                market_type: { type: 'string' as const, description: 'm' }
            },
            execute: vi.fn(async ({ game_id }: any) => {
                calledPairs.push(`${name}::${game_id}`);
                if (name === 'get_market_movement') {
                    return {
                        success: true,
                        summary: `[MARKET MOVEMENT: ${game_id}] ml_home: -135 | ml_away: +115 | spread: -2.5`,
                        data: { ml_home: -135, ml_away: 115, spread: -2.5 }
                    };
                }
                return { success: true, summary: `[${name}: ${game_id}] fresh data` };
            })
        }));

        const proposerB = makeAgent('Manager Node', 'gemini', () =>
            JSON.stringify({
                ui_title: '2-Leg Parlay',
                summary: 'Backing R1 Orlando Magic ML and R2 Chicago Bulls ML.',
                picks: [
                    { row: 'R1', event_id: 'nba-401909306', side: 'Orlando Magic ML', reason: 'Magic ML.' },
                    { row: 'R2', event_id: 'nba-401909309', side: 'Chicago Bulls ML', reason: 'Bulls ML.' }
                ]
            })
        );
        const criticB = makeAgent('Risk Critic', 'groq', () =>
            JSON.stringify({ pass: true, feedback: 'Verified 2 legs.' })
        );

        const resB = await new AnalysisLifecycle(proposerB, criticB, 1, {
            toolRegistry: new ToolRegistry(trackedTools),
            queryCache: new GameQueryCache()
        }).executeAndVerify(
            {
                rawBoard: SLATE_3_GAMES,
                fullBoard: SLATE_3_GAMES,
                toolEvidenceItems: [
                    {
                        tool: 'get_market_movement',
                        eventId: 'nba-401909306',
                        summary: '[MARKET MOVEMENT: nba-401909306] ml_home: -110 | ml_away: -110 | spread: -1.5'
                    },
                    {
                        tool: 'get_injury_and_roster_delta',
                        eventId: 'nba-401909306',
                        summary: '[INJURY & ROSTER DELTA: nba-401909306] Brooklyn Nets (BKN): Cam Thomas (G): OUT'
                    },
                    {
                        tool: 'get_market_movement',
                        eventId: 'nba-401909309',
                        summary: '[MARKET MOVEMENT: nba-401909309 | all] no FanDuel snapshots tracked (0 snapshots).'
                    },
                    {
                        tool: 'get_matchup_fundamentals',
                        eventId: 'nba-401909309',
                        summary: 'Error fetching matchup fundamentals for nba-401909309: rpc_failed_500'
                    }
                ]
            },
            new SwarmContext(),
            'Build 2-leg parlay.',
            'Verify proposal.'
        );

        expect(resB.success).toBe(true);
        expect(calledPairs).not.toContain('get_market_movement::nba-401909306');
        expect(calledPairs).not.toContain('get_injury_and_roster_delta::nba-401909306');
        expect(calledPairs).toContain('get_matchup_fundamentals::nba-401909306');
        expect(calledPairs).toContain('get_environment_and_weather::nba-401909306');
        expect(calledPairs).toContain('get_market_movement::nba-401909309');
        expect(calledPairs).toContain('get_matchup_fundamentals::nba-401909309');
        expect(calledPairs).toContain('get_injury_and_roster_delta::nba-401909309');
        expect(calledPairs).toContain('get_environment_and_weather::nba-401909309');
    });

    it('S5: trims oversize tool evidence by whole EVENT blocks so >=1 block survives with evidenceChars > 0', () => {
        const eventBlocks = Array.from({ length: 10 }, (_, i) => {
            const idx = i + 1;
            const pad = `detail${idx} `.repeat(90).trim();
            return `EVENT nba-4019094${String(idx).padStart(2, '0')} Away${idx} @ Home${idx}\nINJ: Home${idx}: Player${idx} OUT\nMKT: spread -${idx}.5 | ${pad}`;
        });
        const oversizeEvidence = eventBlocks.join('\n\n');

        const ctx = new SwarmContext();
        const analysts = [
            makeAgent('Quant Proposer', 'nvidia', () => '{}'),
            makeAgent('Market Proposer', 'cloudflare', () => '{}')
        ];
        const manager = makeAgent('Manager Node', 'groq', () => '{}');

        const res = compileSynthesisPrompt({
            task: 'Evaluate slate',
            rawInput: 'event_id=nba-401909401 | sport=basketball_nba | Away1 @ Home1',
            analysts,
            managerAgent: manager,
            allAnalystReports: [
                [{ summary: 'Quant pass', insights: ['No edge'], anomalies: [], coveredEventIds: ['nba-401909401'], picks: [] }],
                [{ summary: 'Market pass', insights: ['Lines efficient'], anomalies: [], coveredEventIds: ['nba-401909401'], picks: [] }]
            ],
            clusterDigests: {},
            historicalContext: '',
            context: ctx,
            params: { task: 'Evaluate slate', callerAppId: 'duelodds' } as any,
            bypassCache: true,
            verifierEvidence: oversizeEvidence
        });

        expect(res.effectiveDynamicPrompt.length).toBeLessThanOrEqual(5600);
        expect(res.effectiveDynamicPrompt).toContain('[evidence trimmed]');
        expect(res.effectiveDynamicPrompt).toContain(eventBlocks[0]);
        expect(res.effectiveDynamicPrompt).not.toContain(eventBlocks[9]);

        const telemetryEvent = ctx.events.find((e: any) => e.action === 'Manager Synthesis Context');
        expect(telemetryEvent?.output?.evidenceChars).toBeGreaterThan(0);
        expect(telemetryEvent?.output?.evidenceDropped).toBe(false);

        // Extreme case: single giant EVENT block larger than available budget -> evidenceDropped = true, evidenceChars = 0
        const ctxDrop = new SwarmContext();
        const singleGiantBlock = `EVENT nba-401909999 GiantAway @ GiantHome\nMKT: ${'x'.repeat(5800)}`;
        const resDrop = compileSynthesisPrompt({
            task: 'Evaluate slate',
            rawInput: 'event_id=nba-401909999 | sport=basketball_nba | GiantAway @ GiantHome',
            analysts,
            managerAgent: manager,
            allAnalystReports: [
                [{ summary: 'Quant pass', insights: ['No edge'], anomalies: [], picks: [] }]
            ],
            clusterDigests: {},
            historicalContext: '',
            context: ctxDrop,
            params: { task: 'Evaluate slate', callerAppId: 'duelodds' } as any,
            bypassCache: true,
            verifierEvidence: singleGiantBlock
        });

        expect(resDrop.effectiveDynamicPrompt.length).toBeLessThanOrEqual(5600);
        expect(resDrop.effectiveDynamicPrompt).toContain('[tool evidence omitted: over budget]');
        const dropEvent = ctxDrop.events.find((e: any) => e.action === 'Manager Synthesis Context');
        expect(dropEvent?.output?.evidenceChars).toBe(0);
        expect(dropEvent?.output?.evidenceDropped).toBe(true);
    });

    it('S6: 0-pick bad claims (ungrounded form, false missing-data, contradicted streak) are rewritten with Corrections and keep pass=true', async () => {
        const spySet = makeToolSpies();
        const evidence = [
            'EVENT nba-401909306 Orlando Magic @ Brooklyn Nets',
            'FUND: Away (ORL): W-L 3-2 | PF/PA 115 / 110 | Net Margin +5 | Recent W,L,W,W,L | Home (BKN): W-L 2-3 | PF/PA 108 / 112 | Net Margin -4 | Recent L,L,W,L,W',
            'MKT: Open spread 5.5 -> Current spread 6.5 | Total 222.5 | ml_home +205 | ml_away -245'
        ].join('\n');

        const proposer = makeAgent('Manager Node', 'gemini', () =>
            JSON.stringify({
                ui_title: 'Pass on Slate',
                summary:
                    'Passing on tonight slate. Orlando Magic are 0-2 L2 right now. No market movement was fetched for Orlando Magic. Orlando Magic are on a 5-game winning streak.',
                picks: []
            })
        );
        const critic = makeAgent('Risk Critic', 'groq', () =>
            JSON.stringify({ pass: true, feedback: 'Valid pass.' })
        );

        const res = await new AnalysisLifecycle(proposer, critic, 2, {
            toolRegistry: spySet.registry,
            queryCache: new GameQueryCache()
        }).executeAndVerify(
            {
                rawBoard: SLATE_3_GAMES,
                fullBoard: SLATE_3_GAMES,
                toolResults: evidence,
                toolCallTrace: [
                    { tool: 'get_matchup_fundamentals', eventId: 'nba-401909306', status: 'data', summary: evidence },
                    { tool: 'get_market_movement', eventId: 'nba-401909306', status: 'data', summary: evidence }
                ]
            },
            new SwarmContext(),
            'Build parlay or pass.',
            'Verify proposal.'
        );

        expect(res.success).toBe(true);
        expect(res.attempts).toBe(1);
        expect(res.finalProposal.picks).toEqual([]);
        expect(res.finalProposal.summary).toContain('Passing on tonight slate.');
        expect(res.finalProposal.summary).toContain('Corrections:');
        expect(res.finalProposal.summary).not.toContain('0-2 L2');
        expect(res.finalProposal.summary).not.toMatch(/no market movement/i);
        expect(res.finalProposal.summary).not.toMatch(/5-game winning streak/i);
        for (const t of spySet.tools) {
            expect(t.execute).toHaveBeenCalledTimes(0);
        }
    });

    it('S7: salvages only json verdict payloads with boolean pass and rejects repo_browser.search or non-verdict json', async () => {
        const callWithFailedGen = (failedGen: Record<string, unknown>, isJson = false) => {
            const errorBody = JSON.stringify({
                error: {
                    message: 'Failed to call a function. Please adjust your prompt.',
                    type: 'invalid_request_error',
                    code: 'tool_use_failed',
                    failed_generation: JSON.stringify(failedGen)
                }
            });
            vi.stubGlobal('fetch', vi.fn(async () => new Response(errorBody, {
                status: 400,
                headers: { 'content-type': 'application/json' }
            })));
            return executeOpenAiCompatibleChat(
                { modelName: 'llama-3.3-70b-versatile', contents: 'Audit picks' } as any,
                {
                    providerName: 'groq',
                    providerLabel: 'Groq',
                    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
                    apiKey: 'test-key',
                    modelName: 'llama-3.3-70b-versatile',
                    messages: [{ role: 'user', content: 'Audit picks' }],
                    maxTokens: 1024,
                    isJson,
                    timeoutMs: 5000,
                    tools: [{ type: 'function', function: { name: 'get_market_movement', parameters: {} } }]
                }
            );
        };

        await expect(
            callWithFailedGen({
                name: 'repo_browser.search',
                arguments: { path: '', query: 'nba-401909306', max_results: 20 }
            })
        ).rejects.toThrow();

        await expect(
            callWithFailedGen({
                name: 'json',
                arguments: { path: '', query: 'nba-401909306' }
            }, true)
        ).rejects.toThrow();

        const verdictArgs = { pass: true, verdict: 'PASS', flags: [] };
        const salvaged = await callWithFailedGen({
            name: 'json',
            arguments: verdictArgs
        });
        expect(JSON.parse(salvaged)).toEqual(verdictArgs);
    });

    it('S8: unknown sportHint falls back to gameId prefix so numeric team_id keeps injury rows', async () => {
        const rpcPayload = {
            game_id: 'nba-401909307',
            sport: 'unknown',
            injuries: [
                {
                    team_id: '5',
                    player_name: 'Evan Mobley',
                    position: 'PF',
                    status: 'out'
                }
            ]
        };
        const fetchFn = vi.fn(async () =>
            new Response(JSON.stringify(rpcPayload), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            })
        );

        const res = await getInjuryAndRosterDeltaTool.execute(
            { game_id: 'nba-401909307' },
            {
                fetchFn: fetchFn as unknown as typeof fetch,
                env: {
                    SUPABASE_URL: 'https://example.supabase.co',
                    SUPABASE_ANON_KEY: 'test-anon-key'
                },
                game: { sport: 'unknown' }
            } as any
        );

        expect(res.success).toBe(true);
        expect(res.data?.injuries).toHaveLength(1);
        expect(res.data?.injuries[0].team_abbr).toBe('CLE');
        expect(res.summary).toContain('Evan Mobley');
    });
});
