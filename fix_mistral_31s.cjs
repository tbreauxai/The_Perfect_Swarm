const fs = require('fs');
let code = fs.readFileSync('swarm.ts', 'utf-8');

code = code.replace(
    /setTimeout\(releaseMutex, 1500\);/g,
    `setTimeout(releaseMutex, 31000); // 31 seconds to respect 2 RPM limit`
);

code = code.replace(
    /console\.log\("\[Mistral\] Waiting for global mutex lock\.\.\."\);/g,
    `console.log("[Mistral] Waiting for global mutex lock (Enforcing 31s pacing for 2 RPM limit)...");`
);

fs.writeFileSync('swarm.ts', code);
console.log("Patched Mistral mutex to 31 seconds");
