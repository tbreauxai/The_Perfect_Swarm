const fs = require('fs');
let swarm = fs.readFileSync('swarm.ts', 'utf-8');

swarm = swarm.replace(/data\.choices\[0\]\?/g, "data?.choices?.[0]?");
fs.writeFileSync('swarm.ts', swarm);
