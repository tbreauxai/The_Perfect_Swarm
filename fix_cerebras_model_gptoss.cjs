const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');
code = code.replace(
    /analysts\.push\(new Agent\('Cerebras Analyst', 'llama3\.1-8b', 'cerebras'/,
    "analysts.push(new Agent('Cerebras Analyst', 'gpt-oss-120b', 'cerebras'"
);
fs.writeFileSync('server.ts', code);
