const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf-8');

// Move truncation to the VERY TOP of the try block
server = server.replace(
    'let rawInput = data || "";',
    `let rawInput = data || "";
        const MAX_CHARS = 500000;
        if (rawInput.length > MAX_CHARS) {
            console.log("Truncating raw input early to prevent OOM...");
            rawInput = rawInput.substring(0, MAX_CHARS) + "\\n...[TRUNCATED FOR MEMORY SAFETY]...";
        }`
);

// Remove the old truncation block
server = server.replace(
    `        const MAX_CHARS = 500000; // ~500KB of text is plenty for the Swarm context
        if (rawInput.length > MAX_CHARS) {
            console.log("Truncating raw input from " + rawInput.length + " chars to " + MAX_CHARS + " chars to prevent Node.js Out of Memory (OOM) crash.");
            rawInput = rawInput.substring(0, MAX_CHARS) + "\\n...[TRUNCATED FOR MEMORY SAFETY]...";
        }`,
    ''
);

fs.writeFileSync('server.ts', server);
console.log("Real OOM patch applied.");
