const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf-8');
let swarm = fs.readFileSync('swarm.ts', 'utf-8');

// 1. Change gemini-3.1-pro-preview to gemini-3.6-flash to bypass the quota block
server = server.replace(
    "'gemini-3.1-pro-preview'",
    "'gemini-3.6-flash'"
);
server = server.replace(
    'complex: "gemini-3.1-pro-preview",',
    'complex: "gemini-3.6-flash",'
);
fs.writeFileSync('server.ts', server);

// 2. Prevent the swarm from waiting > 10 seconds per retry, and cap retries
swarm = swarm.replace(
    'const maxRetries = 7;',
    'const maxRetries = 2;' // Fail fast
);
swarm = swarm.replace(
    'await new Promise(resolve => setTimeout(resolve, delayMs));',
    `
                if (delayMs > 15000) {
                    console.log("Retry delay of " + delayMs + "ms is too long. Capping at 10000ms to avoid 60s gateway timeouts.");
                    delayMs = 10000; 
                }
                await new Promise(resolve => setTimeout(resolve, delayMs));`
);

fs.writeFileSync('swarm.ts', swarm);
console.log("Quota patch applied.");
