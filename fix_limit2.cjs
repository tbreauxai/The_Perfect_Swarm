const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf-8');

// The original limit patch might have missed some edge cases if the request is URL-encoded or uses other middleware
server = server.replace(
    "app.use(express.json({ limit: '50mb' }));",
    "app.use(express.json({ limit: '100mb' }));\napp.use(express.urlencoded({ limit: '100mb', extended: true }));"
);

fs.writeFileSync('server.ts', server);
console.log("Limit 2 applied.");
