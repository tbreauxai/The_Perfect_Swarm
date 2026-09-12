const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf-8');

const target = `                if (collections.collections.length > 0) {
                    const names = collections.collections.map(c => c.name).join(', ');
                    historicalContext = "Historical databases found in Qdrant: " + names + ". Proceeding with analysis.";
                } else {
                    historicalContext = "No historical indexes found in Qdrant. Proceeding with current data only.";
                }`;

const replacement = `                if (collections.collections.length > 0) {
                    historicalContext = "Vector Database is connected. No specific domain index selected for this task.";
                } else {
                    historicalContext = "No historical indexes found in Qdrant. Proceeding with current data only.";
                }`;

if(server.includes(target)) {
    server = server.replace(target, replacement);
    fs.writeFileSync('server.ts', server);
    console.log("Patched Qdrant context to not leak collection names");
} else {
    console.log("Could not find the target string in server.ts");
}
