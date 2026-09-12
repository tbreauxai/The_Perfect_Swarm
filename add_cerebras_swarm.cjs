const fs = require('fs');
let code = fs.readFileSync('swarm.ts', 'utf-8');

// Update Provider type
code = code.replace(
    /export type Provider = 'gemini' \| 'groq' \| 'openrouter' \| 'github';/,
    "export type Provider = 'gemini' | 'groq' | 'openrouter' | 'github' | 'cerebras';"
);

// Add Cerebras execution logic right after Groq
const groqBlock = `                }
                else if (this.provider === 'github') {`;

const cerebrasBlock = `                }
                else if (this.provider === 'cerebras') {
                    const messages: any[] = [];
                    if (this.systemInstruction) {
                        messages.push({ role: 'system', content: this.systemInstruction });
                    }
                    messages.push({ role: 'user', content: prompt });

                    const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Authorization': \`Bearer \${this.apiKey}\`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            model: this.modelName,
                            messages: messages,
                            response_format: config?.responseMimeType === 'application/json' ? { type: 'json_object' } : undefined
                        })
                    });
                    
                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(\`Cerebras API Error: \${errorText}\`);
                    }
                    const data = await response.json();
                    textOutput = data.choices[0]?.message?.content || '';
                }
                else if (this.provider === 'github') {`;

code = code.replace(groqBlock, cerebrasBlock);
fs.writeFileSync('swarm.ts', code);
