import { describe, it, expect, beforeEach } from 'vitest';
import { executeSwarmWorkflow, SwarmEngine } from './engine.ts';
import { ProviderRegistry } from './providers/registry.ts';

describe('SwarmEngine: Hierarchical Agent Specialization & Dynamic Routing Integration', () => {
    beforeEach(() => {
        ProviderRegistry.register({
            providerName: 'hierarchy-mock',
            async call(options) {
                const prompt = options.prompt || '';
                const systemInst = options.systemInstruction || '';

                if (systemInst.includes('Manager') || prompt.includes('Analyst Reports:')) {
                    return JSON.stringify({
                        ui_title: 'Hierarchical Synthesis Executive Briefing',
                        components: [
                            {
                                id: 'c1',
                                type: 'InsightList',
                                props: {
                                    title: 'Hierarchical Findings',
                                    insights: [
                                        { type: 'info', message: 'Synthesized from Tier-based specialist delegations' }
                                    ]
                                }
                            }
                        ]
                    });
                }

                if (systemInst.includes('Critic') || prompt.includes('Verify whether this analysis faithfully represents')) {
                    return JSON.stringify({
                        pass: true,
                        computedRating: 94,
                        criticFeedback: 'Hierarchical specialization analysis verified.'
                    });
                }

                // If prompt contains anomaly marker, return anomalies to test escalation
                if (prompt.includes('CRITICAL_ANOMALY')) {
                    return JSON.stringify({
                        summary: 'Critical vulnerability breached security boundary.',
                        insights: ['Zero-day exploit detected in auth token verification'],
                        anomalies: ['Unauthorized privilege escalation', 'Memory safety corruption in cipher module']
                    });
                }

                return JSON.stringify({
                    summary: 'Specialist analysis nominal.',
                    insights: ['Security policy compliant', 'Latency within SLA thresholds'],
                    anomalies: []
                });
            }
        });
    });

    it('organizes agents into hierarchical specialist tree and emits routing plans and delegations', async () => {
        const result = await executeSwarmWorkflow({
            task: 'Audit authentication token security and investigate vulnerability exploits',
            data: 'Analyzing JWT token expiration, signature verification routines, and permission scopes.',
            forceFullSwarm: true,
            settings: {
                hierarchySettings: {
                    enabled: true,
                    delegationEnabled: true,
                    escalationEnabled: true
                },
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'hierarchy-mock', model: 'mock-model', apiKey: 'k-hier' },
                    { id: 'sec-lead', role: 'Security Architect', provider: 'hierarchy-mock', model: 'mock-model', apiKey: 'k-hier' },
                    { id: 'sec-spec', role: 'Vulnerability Specialist', provider: 'hierarchy-mock', model: 'mock-model', apiKey: 'k-hier' },
                    { id: 'perf-spec', role: 'Latency Specialist', provider: 'hierarchy-mock', model: 'mock-model', apiKey: 'k-hier' }
                ]
            }
        });

        expect(result).toBeDefined();
        expect(result.finalAnalysis).toBeDefined();

        // Verify hierarchy result structure
        expect(result.hierarchy).toBeDefined();
        expect(result.hierarchy!.totalNodes).toBe(4);
        expect(result.hierarchy!.treeDepth).toBeGreaterThanOrEqual(3);
        expect(result.hierarchy!.tierCounts[0]).toBe(1); // Manager Node (Tier 0)
        expect(result.hierarchy!.tierCounts[1]).toBe(1); // Security Architect (Tier 1)
        expect(result.hierarchy!.tierCounts[2]).toBe(2); // Specialists (Tier 2)

        // Verify telemetry events
        const planEvents = result.events.filter(e => e.action === 'Hierarchical Routing Plan');
        expect(planEvents.length).toBe(1);
        expect(planEvents[0].output.treeMetrics.totalNodes).toBe(4);

        const delegationEvents = result.events.filter(e => e.action === 'Specialist Delegation');
        expect(delegationEvents.length).toBeGreaterThanOrEqual(1);
        expect(delegationEvents[0].output.delegationChain.length).toBeGreaterThan(1);
    });

    it('triggers upward escalation protocol when specialist encounters anomalies', async () => {
        const result = await executeSwarmWorkflow({
            task: 'Audit critical security perimeter',
            data: 'CRITICAL_ANOMALY: High severity exploit attempting unauthorized privilege escalation in auth system.',
            forceFullSwarm: true,
            settings: {
                hierarchySettings: {
                    enabled: true,
                    escalationEnabled: true
                },
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'hierarchy-mock', model: 'mock-model', apiKey: 'k-hier' },
                    { id: 'sec-lead', role: 'Security Architect', provider: 'hierarchy-mock', model: 'mock-model', apiKey: 'k-hier' },
                    { id: 'sec-spec', role: 'Vulnerability Specialist', provider: 'hierarchy-mock', model: 'mock-model', apiKey: 'k-hier' }
                ]
            }
        });

        expect(result.hierarchy).toBeDefined();
        expect(result.hierarchy!.escalatedTasksCount).toBeGreaterThan(0);

        // Verify Specialist Escalation events across tiers
        const escalationEvents = result.events.filter(e => e.action === 'Specialist Escalation');
        expect(escalationEvents.length).toBeGreaterThanOrEqual(2);

        const secSpecEscalation = escalationEvents.find(e => e.output.fromRole === 'Vulnerability Specialist');
        expect(secSpecEscalation).toBeDefined();
        expect(secSpecEscalation!.output.anomalyCount).toBe(2);
        expect(secSpecEscalation!.output.toRole).toBe('Security Architect');

        const secLeadEscalation = escalationEvents.find(e => e.output.fromRole === 'Security Architect');
        expect(secLeadEscalation).toBeDefined();
        expect(secLeadEscalation!.output.toRole).toBe('Manager Node');
    });

    it('bypasses hierarchical routing when hierarchySettings.enabled is false', async () => {
        const engine = new SwarmEngine({
            hierarchySettings: {
                enabled: false
            }
        });

        const result = await engine.execute({
            task: 'Routine diagnostics task',
            data: 'System running smoothly',
            forceFullSwarm: true,
            settings: {
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'hierarchy-mock', model: 'mock-model', apiKey: 'k-hier' },
                    { id: 'perf-spec', role: 'Performance Engineer', provider: 'hierarchy-mock', model: 'mock-model', apiKey: 'k-hier' }
                ]
            }
        });

        expect(result.hierarchy).toBeUndefined();
        const planEvents = result.events.filter(e => e.action === 'Hierarchical Routing Plan');
        expect(planEvents.length).toBe(0);
    });

    it('suppresses upward escalation when hierarchySettings.escalationEnabled is false', async () => {
        const result = await executeSwarmWorkflow({
            task: 'Audit perimeter vulnerability',
            data: 'CRITICAL_ANOMALY: Suspicious exploit detected',
            forceFullSwarm: true,
            settings: {
                hierarchySettings: {
                    enabled: true,
                    escalationEnabled: false
                },
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'hierarchy-mock', model: 'mock-model', apiKey: 'k-hier' },
                    { id: 'sec-spec', role: 'Vulnerability Specialist', provider: 'hierarchy-mock', model: 'mock-model', apiKey: 'k-hier' }
                ]
            }
        });

        expect(result.hierarchy).toBeDefined();
        expect(result.hierarchy!.escalatedTasksCount).toBe(0);
        const escalationEvents = result.events.filter(e => e.action === 'Specialist Escalation');
        expect(escalationEvents.length).toBe(0);
    });
});
