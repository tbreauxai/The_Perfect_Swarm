import { GoogleGenAI, Type } from '@google/genai';

export interface SwarmEvent {
    id: string;
    timestamp: string;
    agentRole: string;
    action: string;
    modelName: string;
    prompt: string;
    output?: any;
    error?: string;
    durationMs?: number;
}

export class SwarmContext {
    events: SwarmEvent[] = [];

    addEvent(event: Omit<SwarmEvent, 'id' | 'timestamp'>) {
        this.events.push({
            ...event,
            id: Math.random().toString(36).substring(2, 9),
            timestamp: new Date().toISOString()
        });
    }
}

export type Provider = 'gemini' | 'groq' | 'openrouter' | 'github' | 'mistral';

let mistralMutex: Promise<void> = Promise.resolve();

export class Agent {
    private systemInstruction?: string;

    constructor(
        public role: string,
        public modelName: string,
        public provider: Provider,
        private apiKey: string,
        private aiClient?: GoogleGenAI
    ) {}

    setSystemInstruction(instruction: string) {
        this.systemInstruction = instruction;
    }

    async run(prompt: string, context: SwarmContext, config?: any): Promise<any> {
        const startTime = Date.now();
        context.addEvent({
            agentRole: this.role,
            action: 'Started execution',
            modelName: `${this.provider} / ${this.modelName}`,
            prompt: prompt,
        });

        const maxRetries = 2;
        let lastError: any = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                let textOutput = '';

                if (this.provider === 'gemini') {
                    if (!this.aiClient) throw new Error("Gemini client not initialized");
                    
                    const reqConfig = { ...config };
                    if (this.systemInstruction) {
                        reqConfig.systemInstruction = this.systemInstruction;
                    }

                    const response = await this.aiClient.models.generateContent({
                        model: this.modelName,
                        contents: prompt,
                        config: reqConfig
                    });
                    textOutput = response.text || '';
                } 
                else if (this.provider === 'groq') {
                    const messages: any[] = [];
                    if (this.systemInstruction) {
                        messages.push({ role: 'system', content: this.systemInstruction });
                    }
                    messages.push({ role: 'user', content: prompt });

                    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${this.apiKey}`,
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        body: JSON.stringify({
                            model: this.modelName,
                            messages: messages,
                            max_tokens: 1500,
                            response_format: config?.responseMimeType === 'application/json' ? { type: 'json_object' } : undefined
                        })
                    });
                    
                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(`Groq API Error: ${errorText}`);
                    }
                    const data = await response.json();
                    textOutput = data?.choices?.[0]?.message?.content || '';
                }

                else if (this.provider === 'mistral') {
                    // Mistral Free Tier strict 1 Request Per Second limit prevention - GLOBAL MUTEX
                    console.log("[Mistral] Waiting for global mutex lock (Enforcing 31s pacing for 2 RPM limit)...");
                    await mistralMutex;
                    let releaseMutex: () => void;
                    mistralMutex = new Promise(resolve => { releaseMutex = resolve as () => void; });

                    try {
                        const messages: any[] = [];
                    if (this.systemInstruction) {
                        messages.push({ role: 'system', content: this.systemInstruction });
                    }
                    messages.push({ role: 'user', content: prompt });
                    
                    const endpoint = 'https://api.mistral.ai/v1/chat/completions';

                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${this.apiKey}`,
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        body: JSON.stringify({
                            model: this.modelName,
                            messages: messages,
                            max_tokens: 1500,
                            response_format: config?.responseMimeType === 'application/json' ? { type: 'json_object' } : undefined
                        })
                    });
                    
                    // Diagnostic Logs for the user
                    const rateLimitRemaining = response.headers.get('x-ratelimit-remaining') || 'unknown';
                    const rateLimitLimit = response.headers.get('x-ratelimit-limit') || 'unknown';
                    console.log(`[Mistral Diagnostic] RPS Limit: ${rateLimitLimit} | Remaining: ${rateLimitRemaining}`);
                    
                    if (!response.ok) {
                        const errorText = await response.text();
                        console.error(`[Mistral Diagnostic] 429 Hit. Headers:`, Object.fromEntries(response.headers.entries()));
                        throw new Error(`Mistral API Error: ${errorText}`);
                    }
                    const data = await response.json();
                    textOutput = data?.choices?.[0]?.message?.content || '';
                    } finally {
                        // Ensure at least 1500ms delay between the end of this request and the start of the next
                        setTimeout(releaseMutex, 31000); // 31 seconds to respect 2 RPM limit
                    }
                }
                else if (this.provider === 'github') {
                    const messages: any[] = [];
                    if (this.systemInstruction) {
                        messages.push({ role: 'system', content: this.systemInstruction });
                    }
                    messages.push({ role: 'user', content: prompt });

                    let reqConfig = { ...config };
                    // GitHub API generally ignores response_format if not supported, but we can pass it if it is JSON
                    const bodyParams: any = {
                        model: this.modelName,
                        messages,
                        temperature: reqConfig.temperature || 0.7
                    };
                    if (reqConfig.responseMimeType === "application/json") {
                        bodyParams.response_format = { type: "json_object" };
                    }

                    const response = await fetch('https://models.github.ai/inference/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${this.apiKey}`,
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
                    textOutput = data?.choices?.[0]?.message?.content || '';
                }
                else if (this.provider === 'openrouter') {
                    const messages: any[] = [];
                    if (this.systemInstruction) {
                        messages.push({ role: 'system', content: this.systemInstruction });
                    }
                    messages.push({ role: 'user', content: prompt });

                    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${this.apiKey}`,
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        body: JSON.stringify({
                            model: this.modelName,
                            messages: messages,
                            max_tokens: 1500,
                            response_format: config?.responseMimeType === 'application/json' ? { type: 'json_object' } : undefined
                        })
                    });
                    
                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(`OpenRouter API Error: ${errorText}`);
                    }
                    const data = await response.json();
                    textOutput = data?.choices?.[0]?.message?.content || '';
                }

                const durationMs = Date.now() - startTime;
                
                let parsedOutput: any = textOutput;
                
                if (config?.responseMimeType === "application/json") {
                    try {
                        let cleanText = (textOutput || "").replace(/\`\`\`(?:json)?/gi, '').trim();
                        const startIdx = cleanText.indexOf('{');
                        const endIdx = cleanText.lastIndexOf('}');
                        if (startIdx !== -1 && endIdx !== -1) {
                            cleanText = cleanText.substring(startIdx, endIdx + 1);
                        }
                        parsedOutput = JSON.parse(cleanText || "{}");
                    } catch (e) {
                        // fallback
                    }
                }

                context.addEvent({
                    agentRole: this.role,
                    action: attempt > 1 ? `Completed execution (after ${attempt - 1} retries)` : 'Completed execution',
                    modelName: `${this.provider} / ${this.modelName}`,
                    prompt: prompt,
                    output: parsedOutput,
                    durationMs
                });

                return parsedOutput;
            } catch (error: any) {
                lastError = error;
                const errorStr = String(error?.message || error) || '';
                const isRetryable = errorStr.includes('503') || errorStr.includes('429') || errorStr.includes('UNAVAILABLE') || errorStr.includes('fetch failed') || error?.status === 503 || error?.status === 429;
                
                if (!isRetryable || attempt === maxRetries) {
                    break;
                }
                
                context.addEvent({
                    agentRole: this.role,
                    action: `Retry ${attempt}/${maxRetries - 1}`,
                    modelName: `${this.provider} / ${this.modelName}`,
                    prompt: prompt,
                    error: `Transient error encountered: ${errorStr}. Retrying...`,
                });
                
                let delayMs = attempt * 2000;
                // Parse retry delay from error if available (e.g., from Gemini's "Please retry in X.XXXs.")
                const retryMatch = errorStr.match(/Please retry in (\d+(?:\.\d+)?)s/i);
                if (retryMatch && retryMatch[1]) {
                    delayMs = Math.ceil(parseFloat(retryMatch[1]) * 1000) + 1000; // Add 1s buffer
                } else if (errorStr.includes('429') || errorStr.includes('429 Too Many Requests') || error?.status === 429) {
                    // Backoff more aggressively on 429 if no specific time given
                    delayMs = attempt * 5000;
                }
                
                
                if (delayMs > 15000) {
                    console.log("Retry delay of " + delayMs + "ms is too long. Capping at 10000ms to avoid 60s gateway timeouts.");
                    delayMs = 10000; 
                }
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        const durationMs = Date.now() - startTime;
        context.addEvent({
            agentRole: this.role,
            action: 'Failed execution',
            modelName: `${this.provider} / ${this.modelName}`,
            prompt: prompt,
            error: lastError?.message || 'Unknown error',
            durationMs
        });
        throw lastError;
    }
}
