import { Agent } from './agent.ts';
import { SwarmContext } from './context.ts';
import type { Provider } from './types.ts';

export interface BenchmarkResult {
    modelName: string;
    provider: Provider;
    passRouting: boolean;
    routingLatency: number;
    passReasoning: boolean;
    reasoningLatency: number;
    timestamp: string;
}

export interface BenchmarkTarget {
    provider: Provider;
    modelName: string;
    apiKey: string;
}

export class SwarmBenchmarker {
    private lastResults: BenchmarkResult[] = [];
    private targets: BenchmarkTarget[] = [];
    private intervalId?: any;

    constructor(targets: BenchmarkTarget[]) {
        this.targets = targets;
    }

    private async testRouting(target: BenchmarkTarget): Promise<{ pass: boolean, latency: number }> {
        const agent = new Agent('router-tester', target.modelName, target.provider, target.apiKey);
        const context = new SwarmContext();
        const prompt = `Classify this text into one of these intents: ['refund', 'cancel', 'status']. Text: "Where is my order?". Output ONLY valid JSON in the format { "intent": "..." } with no other text.`;
        
        try {
            const start = Date.now();
            const res = await agent.run(prompt, context, { responseMimeType: 'application/json' });
            const latency = Date.now() - start;
            const pass = typeof res === 'object' && res.intent === 'status';
            return { pass, latency };
        } catch (err) {
            console.warn(`[Benchmark] Routing test failed for ${target.provider}/${target.modelName}:`, err);
            return { pass: false, latency: -1 };
        }
    }

    private async testReasoning(target: BenchmarkTarget): Promise<{ pass: boolean, latency: number }> {
        const agent = new Agent('reasoning-tester', target.modelName, target.provider, target.apiKey);
        const context = new SwarmContext();
        const prompt = `Solve this logic puzzle: A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost? Output the final answer as a number in cents, and nothing else.`;
        
        try {
            const start = Date.now();
            // Free tier reasoning models might take a while, 60s timeout
            const res = await agent.run(prompt, context, { timeoutMs: 60000 });
            const latency = Date.now() - start;
            // The correct answer is 5 cents.
            const textOutput = typeof res === 'string' ? res : JSON.stringify(res);
            const pass = textOutput.includes('5');
            return { pass, latency };
        } catch (err) {
            console.warn(`[Benchmark] Reasoning test failed for ${target.provider}/${target.modelName}:`, err);
            return { pass: false, latency: -1 };
        }
    }

    public async run(): Promise<BenchmarkResult[]> {
        console.log(`[Benchmark] Starting benchmark run for ${this.targets.length} models...`);
        const results: BenchmarkResult[] = [];

        for (const target of this.targets) {
            console.log(`[Benchmark] Testing ${target.provider}/${target.modelName}...`);
            
            // 1. Routing test (fast)
            const routing = await this.testRouting(target);
            
            // 2. Reasoning test (slow)
            let reasoning = { pass: false, latency: -1 };
            if (routing.pass) {
                // To avoid immediate rate limits, wait 2 seconds
                await new Promise(resolve => setTimeout(resolve, 2000));
                reasoning = await this.testReasoning(target);
            }

            results.push({
                provider: target.provider,
                modelName: target.modelName,
                passRouting: routing.pass,
                routingLatency: routing.latency,
                passReasoning: reasoning.pass,
                reasoningLatency: reasoning.latency,
                timestamp: new Date().toISOString()
            });

            // Wait between models to respect rate limits
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        this.lastResults = results;
        console.log(`[Benchmark] Completed benchmark run.`);
        return results;
    }

    public startSchedule(intervalMs: number = 24 * 60 * 60 * 1000) {
        if (this.intervalId) {
            clearInterval(this.intervalId);
        }
        
        // Run immediately on start
        this.run().catch(err => console.error('[Benchmark] Error running benchmark:', err));
        
        this.intervalId = setInterval(() => {
            this.run().catch(err => console.error('[Benchmark] Error running benchmark:', err));
        }, intervalMs);
    }

    public stopSchedule() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }

    public getBestModels() {
        if (this.lastResults.length === 0) return null;

        const passedRouting = this.lastResults.filter(r => r.passRouting).sort((a, b) => a.routingLatency - b.routingLatency);
        const passedReasoning = this.lastResults.filter(r => r.passReasoning).sort((a, b) => a.reasoningLatency - b.reasoningLatency);

        return {
            bestRouter: passedRouting.length > 0 ? passedRouting[0] : null,
            bestReasoning: passedReasoning.length > 0 ? passedReasoning[0] : null
        };
    }
}

export const globalBenchmarker = new SwarmBenchmarker([]);

export function initBenchmarker(env: Record<string, any>) {
    const targets: BenchmarkTarget[] = [];
    
    if (env.GROQ_API_KEY) {
        targets.push({ provider: 'groq', modelName: 'mixtral-8x7b-32768', apiKey: env.GROQ_API_KEY });
        targets.push({ provider: 'groq', modelName: 'gemma2-9b-it', apiKey: env.GROQ_API_KEY });
    }
    
    if (env.OPENROUTER_API_KEY) {
        targets.push({ provider: 'openrouter', modelName: 'deepseek/deepseek-r1', apiKey: env.OPENROUTER_API_KEY });
        targets.push({ provider: 'openrouter', modelName: 'google/gemini-flash-1.5', apiKey: env.OPENROUTER_API_KEY });
    }

    if (targets.length > 0) {
        globalBenchmarker['targets'] = targets; // update targets
        globalBenchmarker.startSchedule();
    }
}
