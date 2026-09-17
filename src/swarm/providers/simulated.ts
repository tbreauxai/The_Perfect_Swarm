import type { ProviderAdapter, ProviderCallOptions } from './adapter.ts';

export class SimulatedAdapter implements ProviderAdapter {
    readonly providerName = 'simulated';

    async call(options: ProviderCallOptions): Promise<string> {
        const prompt = options.prompt || '';
        const system = options.systemInstruction || '';

        // Verification Critic Loop
        if (
            system.includes('Quality Critic') ||
            system.includes('Verification Critic') ||
            prompt.includes('Evaluate this proposal') ||
            prompt.includes('Review the synthesized dashboard') ||
            prompt.includes('Verify whether this analysis')
        ) {
            return JSON.stringify({
                pass: true,
                feedback: 'Verified successfully against all criteria. Analysis is coherent and well-substantiated.'
            });
        }

        // Manager Node Synthesis
        if (
            system.includes('Manager') ||
            system.includes('Swarm Orchestrator') ||
            prompt.includes('Analyst Reports:')
        ) {
            return JSON.stringify({
                ui_title: 'Full Swarm Verification Dashboard',
                components: [
                    {
                        id: 'c1',
                        type: 'MetricCard',
                        props: {
                            title: 'Execution Mode',
                            value: 'Full Swarm (Override Active)',
                            subtitle: 'Fast-track bypassed'
                        }
                    },
                    {
                        id: 'c2',
                        type: 'InsightList',
                        props: {
                            title: 'Swarm Verification Findings',
                            insights: [
                                { type: 'info', message: 'Task routed through complete multi-agent pipeline.' },
                                { type: 'success', message: 'Override Fast Track mode active: all stages executed.' }
                            ]
                        }
                    }
                ]
            });
        }

        // Worker Analyst Execution
        return JSON.stringify({
            summary: `Simulated analysis completed for task: ${prompt.slice(0, 60).replace(/\n/g, ' ')}...`,
            anomalies: [],
            insights: [
                'Task processed through multi-agent analysis layer.',
                'Execution verified under full swarm pipeline.'
            ]
        });
    }
}
