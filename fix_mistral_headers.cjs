const fs = require('fs');
let code = fs.readFileSync('swarm.ts', 'utf-8');

// For Mistral
code = code.replace(
    /'Authorization': \`Bearer \$\{this\.apiKey\}\`,
                            'Content-Type': 'application\/json'/g,
    `'Authorization': \`Bearer \$\{this.apiKey\}\`,
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'`
);

// Reduce max tokens to 1500 just to be safe on small tiers
code = code.replace(/max_tokens: 2048/g, 'max_tokens: 1500');

fs.writeFileSync('swarm.ts', code);
console.log("Patched Mistral headers and reduced max_tokens");
