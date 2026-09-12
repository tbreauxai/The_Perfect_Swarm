const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf-8');

const target = `                if (collections.collections.some(c => c.name === 'sports_baselines')) {
                    historicalContext = "Historical Baseline Constraints Loaded from Qdrant: Found 3 relevant past anomalies matching current line spreads.";
                } else {
                    historicalContext = "No historical index 'sports_baselines' found. Proceeding with current data only.";
                }`;

const replacement = `                if (collections.collections.length > 0) {
                    const names = collections.collections.map(c => c.name).join(', ');
                    historicalContext = "Historical databases found in Qdrant: " + names + ". Proceeding with analysis.";
                } else {
                    historicalContext = "No historical indexes found in Qdrant. Proceeding with current data only.";
                }`;

if(server.includes(target)) {
    server = server.replace(target, replacement);
    fs.writeFileSync('server.ts', server);
    console.log("Patched sports_baselines out of server.ts");
} else {
    console.log("Could not find the target string.");
}
