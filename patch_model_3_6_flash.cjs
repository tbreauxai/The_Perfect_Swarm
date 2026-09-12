const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

code = code.replaceAll('gemini-2.5-flash', 'gemini-3.6-flash');

fs.writeFileSync('server.ts', code);
