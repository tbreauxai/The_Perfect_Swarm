const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

code = code.replace(/gemini-3\.1-pro-preview/g, 'gemini-2.5-pro');

fs.writeFileSync('server.ts', code);
console.log("Patched server.ts with stable gemini-2.5-pro");
