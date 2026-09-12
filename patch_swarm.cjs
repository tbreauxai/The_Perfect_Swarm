const fs = require('fs');
let code = fs.readFileSync('swarm.ts', 'utf-8');

code = code.replace(/export type Provider = 'gemini' \| 'groq' \| 'openrouter';/, "export type Provider = 'gemini' | 'groq' | 'openrouter' | 'github';");

const githubLogic = `else if (this.provider === 'github') {
                    const messages: any[] = [];
                    if (this.systemInstruction) {
                        messages.push({ role: 'system', content: this.systemInstruction });
                    }
                    messages.push({ role: 'user', content: prompt });

                    let reqConfig = { ...config };
                    // GitHub API generally ignores response_format if not supported, but we can pass it if it is JSON
                    const bodyParams = {
                        model: this.modelName,
                        messages,
                        temperature: reqConfig.temperature || 0.7
                    };
                    if (reqConfig.responseMimeType === "application/json") {
                        bodyParams.response_format = { type: "json_object" };
                    }

                    const response = await fetch('https://models.inference.ai.azure.com/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Authorization': \`Bearer \${this.apiKey}\`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(bodyParams)
                    });

                    if (!response.ok) {
                        const err = await response.text();
                        throw new Error(\`GitHub API Error: \${response.status} - \${err}\`);
                    }

                    const data = await response.json();
                    textOutput = data.choices[0]?.message?.content || '';
                }`;

code = code.replace(/else if \(this.provider === 'openrouter'\) \{/, githubLogic + "\n                else if (this.provider === 'openrouter') {");

fs.writeFileSync('swarm.ts', code);
