const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf-8');

// Revert Gemini Analyst
server = server.replace(
    "new Agent('Gemini Analyst', 'gemini-3.6-flash', 'gemini'",
    "new Agent('Gemini Analyst', 'gemini-3.1-pro-preview', 'gemini'"
);
// Revert OpenRouter Analyst
server = server.replace(
    "new Agent('OpenRouter Analyst', 'google/gemma-2-9b-it:free', 'openrouter'",
    "new Agent('OpenRouter Analyst', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'openrouter'"
);

fs.writeFileSync('server.ts', server);
console.log("Restored heavy models.");
