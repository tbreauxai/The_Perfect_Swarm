import { ToolRegistry } from './registry.ts';
import type { SwarmTool } from './types.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const mockTool: SwarmTool = {
    name: 'test_slow',
    description: 'Slow tool',
    parameters: {
        ms: { type: 'number', description: 'delay in ms', required: true }
    },
    async execute(params: { ms: number }) {
        await sleep(params.ms);
        return true;
    }
};

async function runBenchmark() {
    const reg = new ToolRegistry([mockTool]);
    const calls = Array(10).fill({ tool: 'test_slow', parameters: { ms: 100 } });

    console.time('executeAllToolCalls');
    await reg.executeAllToolCalls(calls);
    console.timeEnd('executeAllToolCalls');
}

runBenchmark().catch(console.error);
