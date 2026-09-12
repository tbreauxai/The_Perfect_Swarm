const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf-8');

server = server.replace(
    "'nvidia/nemotron-3-ultra-550b-a55b:free'",
    "'google/gemma-2-9b-it:free'"
);

fs.writeFileSync('server.ts', server);
console.log("Patched OpenRouter model.");
