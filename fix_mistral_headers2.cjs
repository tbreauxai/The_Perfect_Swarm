const fs = require('fs');
let code = fs.readFileSync('swarm.ts', 'utf-8');

code = code.split(`'Authorization': \`Bearer \${this.apiKey}\`,
                            'Content-Type': 'application/json'`).join(`'Authorization': \`Bearer \${this.apiKey}\`,
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'`);

code = code.split('max_tokens: 2048').join('max_tokens: 1500');

fs.writeFileSync('swarm.ts', code);
console.log("Patched Mistral headers and reduced max_tokens");
