const fs = require('fs');
let swarm = fs.readFileSync('swarm.ts', 'utf-8');

swarm = swarm.replace(
    /\} else if \(error\?\.status === 429\) \{/g,
    "} else if (errorStr.includes('429') || errorStr.includes('429 Too Many Requests') || error?.status === 429) {"
);

swarm = swarm.replace(
    "const maxRetries = 5;",
    "const maxRetries = 7;" // Increase max retries
);

fs.writeFileSync('swarm.ts', swarm);
