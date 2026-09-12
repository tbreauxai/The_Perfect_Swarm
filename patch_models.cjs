const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

code = code.replaceAll('gemini-3.6-flash', 'gemini-flash-latest');
fs.writeFileSync('server.ts', code);
