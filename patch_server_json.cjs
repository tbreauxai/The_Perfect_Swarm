const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

const oldCatch = `        try {
            finalAnalysis = JSON.parse(orchestratorPlan);
        } catch (e) {
            finalAnalysis = { error: "Failed to generate structured UI payload.", raw: orchestratorPlan };
        }`;

const newCatch = `        try {
            // Strip markdown formatting if the model wrapped the JSON response in code blocks
            const cleanPlan = orchestratorPlan.replace(/^\\\`\\\`\\\`json\\s*/, '').replace(/\\s*\\\`\\\`\\\`$/, '');
            finalAnalysis = JSON.parse(cleanPlan);
        } catch (e) {
            console.error("JSON Parse error:", e);
            finalAnalysis = { error: "Failed to generate structured UI payload.", raw: orchestratorPlan };
        }`;

code = code.replace(oldCatch, newCatch);

fs.writeFileSync('server.ts', code);
