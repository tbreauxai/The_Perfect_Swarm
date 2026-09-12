const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf-8');

server = server.replace(
    /analysts\.push\(new Agent\('Gemini Analyst', 'gemini-3\.1-pro-preview', 'gemini', geminiKey, ai\)\);/,
    "analysts.push(new Agent('Gemini Analyst', 'gemini-3.6-flash', 'gemini', geminiKey, ai));"
);

server = server.replace(
    /analysts\.push\(new Agent\('Groq Analyst', 'openai\/gpt-oss-120b', 'groq',/g,
    "analysts.push(new Agent('Groq Analyst', 'llama-3.3-70b-versatile', 'groq',"
);

server = server.replace(
    /analysts\.push\(new Agent\('Mistral Analyst', 'mistral-small-latest', 'mistral',/g,
    "analysts.push(new Agent('Mistral Analyst', 'mistral-large-latest', 'mistral',"
);

fs.writeFileSync('server.ts', server);
