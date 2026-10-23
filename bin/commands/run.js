import { executeSwarmWorkflow } from '../../dist/swarm/engine.js';
import { ProviderRegistry } from '../../dist/swarm/index.js';

export async function runTask(task, rawArgs) {
    if (!task) {
        console.error('Error: Please specify a task string: perfect-swarm run "Analyze logs"');
        process.exit(1);
    }

    let data = '';
    let appId = 'cli-analysis-app';
    let isMock = false;

    for (let i = 0; i < rawArgs.length; i++) {
        if (rawArgs[i] === '--data' && rawArgs[i + 1]) {
            data = rawArgs[i + 1];
            i++;
        } else if (rawArgs[i] === '--app' && rawArgs[i + 1]) {
            appId = rawArgs[i + 1];
            i++;
        } else if (rawArgs[i] === '--mock') {
            isMock = true;
        }
    }

    if (isMock) {
        ProviderRegistry.register({
            providerName: 'custom-mock',
            async call(_options) {
                return JSON.stringify({
                    ui_title: `Fast Analysis: ${task}`,
                    components: [
                        { id: '1', type: 'InsightList', props: { title: 'CLI Fast Path Output', insights: [{ type: 'info', message: 'Simulated output verified' }] } }
                    ]
                });
            }
        });
    }

    console.log(`\n[PerfectSwarm] Executing Task: "${task}" (App ID: ${appId}${isMock ? ', Mode: mock' : ''})`);
    const startTime = Date.now();

    const result = await executeSwarmWorkflow({
        task,
        data,
        settings: {
            appId,
            ...(isMock ? {
                agents: [
                    { id: 'cli-mgr', role: 'Manager Node', provider: 'custom-mock', model: 'mock-v1', apiKey: 'k-mock' },
                    { id: 'cli-analyst', role: 'Analyst', provider: 'custom-mock', model: 'mock-v1', apiKey: 'k-mock' }
                ]
            } : {})
        }
    });

    const elapsed = Date.now() - startTime;
    console.log(`\n[PerfectSwarm] Completed in ${elapsed}ms:`);
    console.log(JSON.stringify(result.finalAnalysis, null, 2));
}
