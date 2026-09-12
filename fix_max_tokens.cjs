const fs = require('fs');
let code = fs.readFileSync('swarm.ts', 'utf-8');

// For Mistral
code = code.replace(
    /model: this\.modelName,\s*messages: messages,\s*response_format: config\?\.responseMimeType === 'application\/json' \? { type: 'json_object' } : undefined/g,
    `model: this.modelName,
                            messages: messages,
                            max_tokens: 2048,
                            response_format: config?.responseMimeType === 'application/json' ? { type: 'json_object' } : undefined`
);

fs.writeFileSync('swarm.ts', code);
console.log("Patched max_tokens into fetch bodies");
