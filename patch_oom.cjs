const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf-8');

const targetChunkLogic = `        const chunks = [];
        const rawLines = rawInput.split('\\n');`;

const safeChunkLogic = `        const chunks = [];
        // PREVENT OOM CRASHES: Truncate massive strings before allocating millions of array elements in memory
        const MAX_CHARS = 500000; // ~500KB of text is plenty for the Swarm context
        if (rawInput.length > MAX_CHARS) {
            console.log("Truncating raw input from " + rawInput.length + " chars to " + MAX_CHARS + " chars to prevent Node.js Out of Memory (OOM) crash.");
            rawInput = rawInput.substring(0, MAX_CHARS) + "\\n...[TRUNCATED FOR MEMORY SAFETY]...";
        }
        const rawLines = rawInput.split('\\n');`;

if (server.includes(targetChunkLogic)) {
    server = server.replace(targetChunkLogic, safeChunkLogic);
    fs.writeFileSync('server.ts', server);
    console.log("OOM patch applied successfully.");
} else {
    console.log("Could not find chunk logic to patch.");
}
