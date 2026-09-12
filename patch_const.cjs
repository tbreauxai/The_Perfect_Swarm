const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf-8');
server = server.replace('const rawInput = data || "";', 'let rawInput = data || "";');
fs.writeFileSync('server.ts', server);
console.log("Fixed const");
