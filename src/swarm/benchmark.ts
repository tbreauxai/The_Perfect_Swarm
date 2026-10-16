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

interface BenchmarkTestResult {
    pass: boolean;
    latency: number;
    rateLimited: boolean;
}

/** OpenRouter/Groq 429s surface as "[RATE_LIMIT_429] ..." or "... (429) ...". */
export function isRateLimitError(err: unknown): boolean {
    const msg = String((err as any)?.message ?? err ?? '');
    return /\b429\b|RATE_LIMIT/i.test(msg);
}

/**
 * Startup benchmark gate. OFF by default: each run costs ~4 OpenRouter :free calls (50/day cap) and Render restarts
 * often, so it only runs when SWARM_STARTUP_BENCHMARK is "1", "true", "yes" or "on".
 */
export const STARTUP_BENCHMARK_ENV = 'SWARM_STARTUP_BENCHMARK';

export function isStartupBenchmarkEnabled(env: Record<string, any> = {}): boolean {
    return /^(1|true|yes|on)$/i.test(String(env?.[STARTUP_BENCHMARK_ENV] ?? '').trim());
}

/** Models the benchmark tests. The Google free model was dropped (2026-10-16: quota). */
export function buildBenchmarkTargets(env: Record<string, any> = {}): BenchmarkTarget[] {
    const targets: BenchmarkTarget[] = [];
    if (env.GROQ_API_KEY) {
        targets.push({ provider: 'groq', modelName: 'openai/gpt-oss-120b', apiKey: env.GROQ_API_KEY });
        targets.push({ provider: 'groq', modelName: 'openai/gpt-oss-20b', apiKey: env.GROQ_API_KEY });
    }
    if (env.OPENROUTER_API_KEY) {
        targets.push({ provider: 'openrouter', modelName: 'nvidia/nemotron-3-super-120b-a12b:free', apiKey: env.OPENROUTER_API_KEY });
    }
    return targets;
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
    /** Pauses between tests / models (tests set these to 0). */
    public betweenTestsMs = 2000;
    public betweenModelsMs = 5000;

    constructor(targets: BenchmarkTarget[]) {
        this.targets = targets;
    }

    private async testRouting(target: BenchmarkTarget): Promise<BenchmarkTestResult> {
        const agent = new Agent('router-tester', target.modelName, target.provider, target.apiKey);
        const context = new SwarmContext();
        const prompt = `Classify this text into one of these intents: ['refund', 'cancel', 'status']. Text: "Where is my order?". Output ONLY valid JSON in the format { "intent": "..." } with no other text.`;
        
        try {
            const start = Date.now();
            const res = await agent.run(prompt, context, { responseMimeType: 'application/json', noRetry: true, bypassCache: true });
            const latency = Date.now() - start;
            const pass = typeof res === 'object' && res.intent === 'status';
            return { pass, latency, rateLimited: false };
        } catch (err) {
            console.warn(`[Benchmark] Routing test failed for ${target.provider}/${target.modelName}:`, err);
            return { pass: false, latency: -1, rateLimited: isRateLimitError(err) };
        }
    }

    private async testReasoning(target: BenchmarkTarget): Promise<BenchmarkTestResult> {
        const agent = new Agent('reasoning-tester', target.modelName, target.provider, target.apiKey);
        const context = new SwarmContext();
        const prompt = `Solve this logic puzzle: A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost? Output the final answer as a number in cents, and nothing else.`;
        
        try {
            const start = Date.now();
            // Free tier reasoning models might take a while, 60s timeout
            const res = await agent.run(prompt, context, { timeoutMs: 60000, noRetry: true, bypassCache: true });
            const latency = Date.now() - start;
            // The correct answer is 5 cents.
            const textOutput = typeof res === 'string' ? res : JSON.stringify(res);
            const pass = textOutput.includes('5');
            return { pass, latency, rateLimited: false };
        } catch (err) {
            console.warn(`[Benchmark] Reasoning test failed for ${target.provider}/${target.modelName}:`, err);
            return { pass: false, latency: -1, rateLimited: isRateLimitError(err) };
        }
    }

    public async run(): Promise<BenchmarkResult[]> {
        console.log(`[Benchmark] Starting benchmark run for ${this.targets.length} models...`);
        const results: BenchmarkResult[] = [];
        // A provider that answered 429 is not called again in this run (no retry, no further models on it).
        const rateLimitedProviders = new Set<string>();

        for (const target of this.targets) {
            if (rateLimitedProviders.has(target.provider)) {
                console.warn(`[Benchmark] Skipping ${target.provider}/${target.modelName}: ${target.provider} returned 429 earlier in this run.`);
                continue;
            }
            console.log(`[Benchmark] Testing ${target.provider}/${target.modelName}...`);
            
            // 1. Routing test (fast)
            const routing = await this.testRouting(target);
            if (routing.rateLimited) rateLimitedProviders.add(target.provider);

            // 2. Reasoning test (slow)
            let reasoning: BenchmarkTestResult = { pass: false, latency: -1, rateLimited: false };
            if (routing.pass) {
                // To avoid immediate rate limits, wait 2 seconds
                await new Promise(resolve => setTimeout(resolve, this.betweenTestsMs));
                reasoning = await this.testReasoning(target);
                if (reasoning.rateLimited) rateLimitedProviders.add(target.provider);
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
            await new Promise(resolve => setTimeout(resolve, this.betweenModelsMs));
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

/** Returns true when the benchmark schedule was started. Off unless SWARM_STARTUP_BENCHMARK is set (see above). */
export function initBenchmarker(env: Record<string, any>): boolean {
  if (!isStartupBenchmarkEnabled(env)) {
    console.log(
      `[Benchmark] Startup benchmark is off (set ${STARTUP_BENCHMARK_ENV}=1 to enable). No provider calls at boot.`,
    );
    return false;
  }
  const targets = buildBenchmarkTargets(env);
  if (targets.length > 0) {
    globalBenchmarker["targets"] = targets; // update targets
    globalBenchmarker.startSchedule();
    return true;
  }
  return false;
}
