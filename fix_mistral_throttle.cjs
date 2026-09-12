const fs = require('fs');
let code = fs.readFileSync('swarm.ts', 'utf-8');

if (!code.includes('mistralMutex')) {
    code = code.replace(
        /export class Agent \{/,
        `let mistralMutex: Promise<void> = Promise.resolve();\n\nexport class Agent {`
    );
}

const target = `                else if (this.provider === 'mistral') {
                    // Mistral Free Tier strict 1 Request Per Second limit prevention
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    const messages: any[] = [];`;

const replacement = `                else if (this.provider === 'mistral') {
                    // Mistral Free Tier strict 1 Request Per Second limit prevention - GLOBAL MUTEX
                    console.log("[Mistral] Waiting for global mutex lock...");
                    await mistralMutex;
                    let releaseMutex: () => void;
                    mistralMutex = new Promise(resolve => { releaseMutex = resolve as () => void; });

                    try {
                        const messages: any[] = [];`;

const targetFetch = `                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: {
                            'Authorization': \`Bearer \$\{this.apiKey\}\`,
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
                        throw new Error(\`Mistral API Error: \$\{errorText\}\`);
                    }
                    const data = await response.json();
                    textOutput = data?.choices?.[0]?.message?.content || '';
                }`;

const replacementFetch = `                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: {
                            'Authorization': \`Bearer \$\{this.apiKey\}\`,
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
                    console.log(\`[Mistral Diagnostic] RPS Limit: \$\{rateLimitLimit\} | Remaining: \$\{rateLimitRemaining\}\`);
                    
                    if (!response.ok) {
                        const errorText = await response.text();
                        console.error(\`[Mistral Diagnostic] 429 Hit. Headers:\`, Object.fromEntries(response.headers.entries()));
                        throw new Error(\`Mistral API Error: \$\{errorText\}\`);
                    }
                    const data = await response.json();
                    textOutput = data?.choices?.[0]?.message?.content || '';
                    } finally {
                        // Ensure at least 1500ms delay between the end of this request and the start of the next
                        setTimeout(releaseMutex, 1500);
                    }
                }`;

if(code.includes('await new Promise(resolve => setTimeout(resolve, 1500));')) {
    code = code.replace(target, replacement);
    code = code.replace(targetFetch, replacementFetch);
    fs.writeFileSync('swarm.ts', code);
    console.log("Patched mistral throttle successfully!");
} else {
    console.log("Could not find target to replace. Check swarm.ts");
}
