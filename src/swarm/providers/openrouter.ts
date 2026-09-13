import { cleanToken, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';

export class OpenRouterAdapter implements ProviderAdapter {
    readonly providerName = 'openrouter';

    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        if (!key) {
            throw new Error('Missing OpenRouter API key. Please configure a valid key starting with "sk-or-v1-".');
        }

        if (!key.startsWith('sk-or-v1-')) {
            throw new Error(`Invalid OpenRouter key format. OpenRouter keys must begin with 'sk-or-v1-'. If you entered an OpenAI key (sk-...), please obtain a key from openrouter.ai/keys.`);
        }

        const messages: any[] = [];
        if (options.systemInstruction) {
            messages.push({ role: 'system', content: options.systemInstruction });
        }
        messages.push({ role: 'user', content: options.prompt });

        const isJson = options.config?.responseMimeType === 'application/json';

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'HTTP-Referer': 'http://localhost:3000',
                'X-Title': 'The Perfect Swarm'
            },
            body: JSON.stringify({
                model: options.modelName,
                messages,
                max_tokens: options.config?.maxTokens || 1500,
                response_format: isJson ? { type: 'json_object' } : undefined
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenRouter API Error: ${errorText}`);
        }

        const data = await response.json();
        return data?.choices?.[0]?.message?.content || '';
    }
}
