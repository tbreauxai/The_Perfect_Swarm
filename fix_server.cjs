const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf-8');

server = server.replace(
    "const qdrant = new QdrantClient({ url: qdrantUrl, apiKey: qdrantApiKey });",
    "const qdrant = new QdrantClient({ url: qdrantUrl, apiKey: qdrantApiKey, checkCompatibility: false });"
);

server = server.replace(
    'console.error("Qdrant retrieval failed", err);',
    '// console.error("Qdrant retrieval failed", err);'
);

fs.writeFileSync('server.ts', server);
