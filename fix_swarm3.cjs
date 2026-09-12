const fs = require('fs');
let swarm = fs.readFileSync('swarm.ts', 'utf-8');

swarm = swarm.replace(
    /\$\\{this\.provider === 'mistral' \? 'Mistral' : 'xAI'\\} API Error/g,
    "Mistral API Error"
);

fs.writeFileSync('swarm.ts', swarm);
