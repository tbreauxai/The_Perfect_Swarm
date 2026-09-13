import type { GoogleGenAI } from '@google/genai';
import type { Provider, AgentRunConfig } from './types.ts';
import { SwarmContext } from './context.ts';
import { ProviderRegistry } from './providers/registry.ts';

/**
 * Autonomous Swarm Agent decoupled from specific LLM provider implementations.
 * Delegates execution to registered ProviderAdapters.
 */
export class Agent {
    public role: string;
    public modelName: string;
    public provider: Provider;
    private apiKey: string;
    private aiClient?: GoogleGenAI;
    private systemInstruction?: string;

    constructor(
        role: string,
        modelName: string,
        provider: Provider,
        apiKey: string,
        aiClient?: GoogleGenAI
    ) {
        this.role = role;
        this.modelName = modelName;
        this.provider = provider;
        this.apiKey = apiKey;
        this.aiClient = aiClient;
    }

    setSystemInstruction(instruction: string): void {
        this.systemInstruction = instruction;
    }

    getSystemInstruction(): string | undefined {
        return this.systemInstruction;
    }

    async run(prompt: string, context: SwarmContext, config?: AgentRunConfig): Promise<any> {
        const startTime = Date.now();
        context.addEvent({
            agentRole: this.role,
            action: 'Started execution',
            modelName: `${this.provider} / ${this.modelName}`,
            prompt
        });

        const maxRetries = 2;
        let lastError: any = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const adapter = ProviderRegistry.get(this.provider);
                const textOutput = await adapter.call({
                    modelName: this.modelName,
                    prompt,
                    systemInstruction: this.systemInstruction,
                    apiKey: this.apiKey,
                    aiClient: this.aiClient,
                    config
                });

                const durationMs = Date.now() - startTime;
                let parsedOutput: any = textOutput;

                if (config?.responseMimeType === 'application/json') {
                    try {
                        let cleanText = (textOutput || '').replace(/```(?:json)?/gi, '').trim();
                        const startIdx = cleanText.indexOf('{');
                        const endIdx = cleanText.lastIndexOf('}');
                        if (startIdx !== -1 && endIdx !== -1) {
                            cleanText = cleanText.substring(startIdx, endIdx + 1);
                        }
                        parsedOutput = JSON.parse(cleanText || '{}');
                    } catch {
                        parsedOutput = textOutput;
                    }
                }

                context.addEvent({
                    agentRole: this.role,
                    action: 'Completed execution',
                    modelName: `${this.provider} / ${this.modelName}`,
                    prompt,
                    output: parsedOutput,
                    durationMs
                });

                return parsedOutput;
            } catch (err: any) {
                lastError = err;
                console.warn(`[${this.role}] Attempt ${attempt}/${maxRetries} failed:`, err.message);

                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
                }
            }
        }

        const durationMs = Date.now() - startTime;
        context.addEvent({
            agentRole: this.role,
            action: 'Failed execution',
            modelName: `${this.provider} / ${this.modelName}`,
            prompt,
            error: lastError?.message || String(lastError),
            durationMs
        });

        throw lastError;
    }
}
