const fs = require('fs');
let code = fs.readFileSync('swarm.ts', 'utf-8');

code = code.replace(/https:\/\/models\.inference\.ai\.azure\.com\/chat\/completions/, "https://models.github.ai/inference/chat/completions");

fs.writeFileSync('swarm.ts', code);
