const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

code = code.replace(/gemini-3\.6-flash/g, 'gemini-2.5-flash');

fs.writeFileSync('server.ts', code);
console.log("Switched gemini-3.6-flash to gemini-2.5-flash");
