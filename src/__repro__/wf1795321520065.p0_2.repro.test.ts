import { describe, it, expect, vi } from 'vitest';
import { executeSwarmWorkflow } from '../swarm/engine/index.ts';
import { SwarmContext } from '../swarm/context.ts';
import { ToolRegistry } from '../swarm/tools/index.ts';

describe('wf-1795321520065 P0-2: Orchestrator Empty-Slate Guard (two-hop)', () => {
    it('short-circuits before Qdrant retrieval and LLM/tool calls when two-hop compact slate says "No upcoming games"', async () => {
        const retrieveSpy = vi.fn().mockRejectedValue(new Error('Should not query Qdrant on empty slate'));
        const retrieveExemplarsSpy = vi.fn().mockResolvedValue('');
        const mockCortex: any = {
            retrieve: retrieveSpy,
            retrieveExemplars: retrieveExemplarsSpy,
            retrieveContrastivePostMortems: vi.fn().mockResolvedValue({ wins: [], losses: [], formattedBlock: '' }),
            lookupActionPlan: vi.fn().mockResolvedValue({ hit: false }),
            store: vi.fn()
        };

        const toolExecSpy = vi.fn().mockResolvedValue({ success: true });
        const registry = new ToolRegistry([
            {
                name: 'get_matchup_fundamentals',
                description: 'fundamentals',
                parameters: { game_id: { type: 'string', description: 'id', required: true } },
                execute: toolExecSpy
            },
            {
                name: 'get_market_movement',
                description: 'market',
                parameters: { game_id: { type: 'string', description: 'id', required: true } },
                execute: toolExecSpy
            },
            {
                name: 'get_injury_and_roster_delta',
                description: 'injury',
                parameters: { game_id: { type: 'string', description: 'id', required: true } },
                execute: toolExecSpy
            }
        ]);

        // Fail loudly if any LLM provider call is attempted
        const fetchSpy = vi.fn(async () => {
            throw new Error('Unexpected LLM or network call on empty pregame slate');
        });
        vi.stubGlobal('fetch', fetchSpy);

        const stages: any[] = [];
        const ctx = new SwarmContext();
        try {
            const result = await executeSwarmWorkflow({
                task: "Two-Hop Swarm Review: what's the best parlay to place today?",
                userQuestion: "what's the best parlay to place today?",
                data: '=== COMPACT SLATE ===\nNo upcoming games: 78 started games omitted.',
                triageMode: 'two-hop',
                eventIds: [],
                memoryCortex: mockCortex,
                tools: registry,
                context: ctx,
                disableMemoryRetrieval: false,
                forceFullSwarm: true,
                enableDeepAnalysis: true,
                settings: {
                    appId: 'duelodds',
                    agents: [
                        { id: 'a1', role: 'Quant Proposer', provider: 'gemini', model: 'gemini-2.5-flash' },
                        { id: 'critic', role: 'Risk Critic', provider: 'groq', model: 'llama-3.3-70b-versatile' }
                    ],
                    geminiApiKey: 'test-key',
                    groqApiKey: 'test-key'
                },
                onStage: (payload) => stages.push(payload)
            });

            expect(retrieveSpy).not.toHaveBeenCalled();
            expect(retrieveExemplarsSpy).not.toHaveBeenCalled();
            expect(toolExecSpy).not.toHaveBeenCalled();
            expect(fetchSpy).not.toHaveBeenCalled();

            expect(result.status).toBe('complete');
            expect(result.tools_called).toEqual([]);
            expect(result.hop1Plan?.active_event_ids).toEqual([]);
            expect(result.finalAnalysis?.wageringPass).toBe(true);
            expect(result.finalAnalysis?.criticApproved).toBe(true);
            expect(result.finalAnalysis?.picks).toEqual([]);

            const errorEvents = (result.events || []).filter((e: any) => Boolean(e.error));
            expect(errorEvents).toHaveLength(0);
            expect(stages.some((s) => s.stage === 'hop1_plan')).toBe(true);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('short-circuits immediately when active eventIds is explicitly empty even without the started-count prose string', async () => {
        const retrieveSpy = vi.fn();
        const mockCortex: any = {
            retrieve: retrieveSpy,
            retrieveExemplars: vi.fn(),
            retrieveContrastivePostMortems: vi.fn(),
            lookupActionPlan: vi.fn().mockResolvedValue({ hit: false }),
            store: vi.fn()
        };

        const result = await executeSwarmWorkflow({
            task: 'Analyze tonight slate',
            data: '=== COMPACT SLATE ===\nNo slate events available.',
            triageMode: 'two-hop',
            eventIds: [],
            memoryCortex: mockCortex,
            forceFullSwarm: true,
            settings: {
                appId: 'duelodds',
                agents: [{ id: 'a1', role: 'Quant Proposer', provider: 'simulated', model: 'simulated-swarm-v1' }]
            }
        });

        expect(retrieveSpy).not.toHaveBeenCalled();
        expect(result.finalAnalysis?.wageringPass).toBe(true);
        expect(result.finalAnalysis?.criticApproved).toBe(true);
        expect(result.finalAnalysis?.picks).toEqual([]);
        expect(result.tools_called).toEqual([]);
    });
});
