const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

code = code.replaceAll('gemini-3.8-flash', 'gemini-2.5-flash');

fs.writeFileSync('server.ts', code);
