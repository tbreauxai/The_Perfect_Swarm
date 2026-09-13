import { cleanToken, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';

export class GitHubAdapter implements ProviderAdapter {
    readonly providerName = 'github';

    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        if (!key) {
            throw new Error('Missing GitHub Models Personal Access Token.');
        }

        const messages: any[] = [];
        if (options.systemInstruction) {
            messages.push({ role: 'system', content: options.systemInstruction });
        }
        messages.push({ role: 'user', content: options.prompt });

        const isJson = options.config?.responseMimeType === 'application/json';

        const bodyParams: any = {
            model: options.modelName,
            messages,
            temperature: options.config?.temperature || 0.7
        };
        if (isJson) {
            bodyParams.response_format = { type: 'json_object' };
        }

        const response = await fetch('https://models.github.ai/inference/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(bodyParams)
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`GitHub API Error: ${response.status} - ${err}`);
        }

        const data = await response.json();
        return data?.choices?.[0]?.message?.content || '';
    }
}
