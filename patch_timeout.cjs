const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf-8');

// Limit chunks to a maximum of 2 to prevent 504 timeouts
server = server.replace(
    'if (currentChunk.length > 0) chunks.push(currentChunk);',
    'if (currentChunk.length > 0) chunks.push(currentChunk);\n\n        // Prevent 504 Gateway Timeout by limiting to 2 chunks for synchronous HTTP requests\n        const originalChunkCount = chunks.length;\n        if (chunks.length > 2) {\n            chunks.length = 2;\n            console.log("Truncated chunks to 2 to avoid timeout.");\n        }'
);

// Update Token Budgeting event message
server = server.replace(
    'output: { chunks: chunks.length, maxTokensPerChunk: MAX_TOKENS_PER_CHUNK, totalTokens: estimatedTokens },',
    'output: { chunks: chunks.length, originalChunks: originalChunkCount, maxTokensPerChunk: MAX_TOKENS_PER_CHUNK, totalTokens: estimatedTokens, warning: originalChunkCount > 2 ? "Truncated to 2 chunks to avoid 60s HTTP timeout" : undefined },'
);

// Reduce 15s delay to 2s
server = server.replace(
    'await new Promise(resolve => setTimeout(resolve, 15000));',
    'await new Promise(resolve => setTimeout(resolve, 2000));'
);

server = server.replace(
    'Rate limit prevention: Waiting 15s',
    'Rate limit prevention: Waiting 2s'
);

fs.writeFileSync('server.ts', server);
console.log("Timeout patch applied.");
