const fs = require('fs');
let swarm = fs.readFileSync('swarm.ts', 'utf-8');

const target = `                        const cleanText = (textOutput || "").replace(/^\\^\\\`\\\`\\\`json\\s*/, '').replace(/\\s*\\\`\\\`\\\`$/, '').replace(/^\\\`\\\`\\\`\\s*/, '');
                        parsedOutput = JSON.parse(cleanText || "{}");`;

const replacement = `                        let cleanText = (textOutput || "").replace(/\\\`\\\`\\\`(?:json)?\\s*/g, '').replace(/\\\`\\\`\\\`/g, '').trim();
                        const startIdx = cleanText.indexOf('{');
                        const endIdx = cleanText.lastIndexOf('}');
                        if (startIdx !== -1 && endIdx !== -1) {
                            cleanText = cleanText.substring(startIdx, endIdx + 1);
                        }
                        parsedOutput = JSON.parse(cleanText || "{}");`;

if (swarm.includes(target.split('\\n')[0].trim())) { // looser check
    console.log("Applying advanced JSON parser patch...");
}

// Fallback manual replacement
swarm = swarm.replace(
    `const cleanText = (textOutput || "").replace(/^\\\`\\\`\\\`json\\s*/, '').replace(/\\s*\\\`\\\`\\\`$/, '').replace(/^\\\`\\\`\\\`\\s*/, '');`,
    `let cleanText = (textOutput || "").replace(/\\\`\\\`\\\`(?:json)?/gi, '').trim();
                        const startIdx = cleanText.indexOf('{');
                        const endIdx = cleanText.lastIndexOf('}');
                        if (startIdx !== -1 && endIdx !== -1) {
                            cleanText = cleanText.substring(startIdx, endIdx + 1);
                        }`
);

fs.writeFileSync('swarm.ts', swarm);
console.log("JSON parsing patched.");
