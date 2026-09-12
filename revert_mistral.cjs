const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf-8');

server = server.replace(
    "analysts.push(new Agent('Mistral Analyst', 'mistral-large-latest', 'mistral',",
    "analysts.push(new Agent('Mistral Analyst', 'mistral-small-latest', 'mistral',"
);

fs.writeFileSync('server.ts', server);
