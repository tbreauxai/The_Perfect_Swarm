const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

code = code.replaceAll('gemini-flash-latest', 'gemini-3.8-flash');

fs.writeFileSync('server.ts', code);
