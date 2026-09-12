const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf-8');

server = server.replace(
    'complex: "gemini-3.6-flash"',
    'complex: "gemini-3.1-pro-preview"'
);

fs.writeFileSync('server.ts', server);
console.log("Restored complex model config.");
