const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

code = code.replace("if (settings?.vertexProjectId && settings?.vertexAccessToken) {", `console.log("VERTEX MODE?", !!(settings?.vertexProjectId && settings?.vertexAccessToken));
    if (settings?.vertexProjectId && settings?.vertexAccessToken) {`);

fs.writeFileSync('server.ts', code);
