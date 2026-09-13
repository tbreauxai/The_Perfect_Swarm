import type { ProviderAdapter } from './adapter.ts';
import { GeminiAdapter } from './gemini.ts';
import { GroqAdapter } from './groq.ts';
import { OpenRouterAdapter } from './openrouter.ts';
import { MistralAdapter } from './mistral.ts';
import { GitHubAdapter } from './github.ts';

export class ProviderRegistry {
    private static adapters: Map<string, ProviderAdapter> = new Map();

    static {
        this.register(new GeminiAdapter());
        this.register(new GroqAdapter());
        this.register(new OpenRouterAdapter());
        this.register(new MistralAdapter());
        this.register(new GitHubAdapter());
    }

    static register(adapter: ProviderAdapter): void {
        this.adapters.set(adapter.providerName.toLowerCase(), adapter);
    }

    static get(providerName: string): ProviderAdapter {
        const adapter = this.adapters.get(providerName.toLowerCase());
        if (!adapter) {
            throw new Error(`Unsupported AI Provider: '${providerName}'. Registered providers: ${Array.from(this.adapters.keys()).join(', ')}`);
        }
        return adapter;
    }

    static list(): string[] {
        return Array.from(this.adapters.keys());
    }
}
