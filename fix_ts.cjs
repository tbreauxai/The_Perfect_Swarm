const fs = require('fs');

// Fix server.ts
let server = fs.readFileSync('server.ts', 'utf-8');

// Add missing 'prompt' field in context.addEvent for 'Cortex Retrieval Complete'
server = server.replace(
    "action: 'Cortex Retrieval Complete',",
    "action: 'Cortex Retrieval Complete',\n                    prompt: 'Retrieval completed',"
);

// Add missing 'prompt' field in context.addEvent for 'Cortex Retrieval Failed'
server = server.replace(
    "action: 'Cortex Retrieval Failed',",
    "action: 'Cortex Retrieval Failed',\n                    prompt: 'Retrieval failed',"
);

// Fix port issue
server = server.replace(
    'app.listen(port, "0.0.0.0", () => {',
    'app.listen(Number(port), "0.0.0.0", () => {'
);

fs.writeFileSync('server.ts', server);

// Fix swarm.ts
let swarm = fs.readFileSync('swarm.ts', 'utf-8');
swarm = swarm.replace(
    "const bodyParams = {",
    "const bodyParams: any = {"
);
fs.writeFileSync('swarm.ts', swarm);

console.log("Fixes applied.");
