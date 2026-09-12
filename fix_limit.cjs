const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf-8');
server = server.replace("app.use(express.json());", "app.use(express.json({ limit: '50mb' }));");
fs.writeFileSync('server.ts', server);
