import { cleanToken, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';

let mistralMutex: Promise<void> = Promise.resolve();

export class MistralAdapter implements ProviderAdapter {
    readonly providerName = 'mistral';

    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        if (!key) {
            throw new Error('Missing Mistral API Key.');
        }

        // Mistral Free Tier pacing mutex (31s pacing to respect 2 RPM limit)
        await mistralMutex;
        let releaseMutex: () => void;
        mistralMutex = new Promise(resolve => { releaseMutex = resolve as () => void; });

        try {
            const messages: any[] = [];
            if (options.systemInstruction) {
                messages.push({ role: 'system', content: options.systemInstruction });
            }
            messages.push({ role: 'user', content: options.prompt });

            const isJson = options.config?.responseMimeType === 'application/json';

            const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
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
                throw new Error(`Mistral API Error: ${errorText}`);
            }

            const data = await response.json();
            return data?.choices?.[0]?.message?.content || '';
        } finally {
            setTimeout(releaseMutex!, 31000);
        }
    }
}
