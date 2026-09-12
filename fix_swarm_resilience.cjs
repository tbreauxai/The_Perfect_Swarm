const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf-8');

server = server.replace(
    'console.error("Qdrant retrieval failed:", err);',
    '// console.error("Qdrant retrieval failed:", err);'
);

const targetStr = `            const analystPromises = analysts.map(analyst => {
                const systemInstruction = \`You are a Data Analysis Specialist in a modular swarm.

When given data:
1. PLAN: Check the token weight of the input metadata. Identify 2-3 specific dimensions to investigate.
2. REASON: Analyze differences between current inputs and baselines. Keep internal deductions concise and strictly focused on statistical significance.
3. SANITIZE: Discard raw values and processing traces.
4. EMIT: Return output exclusively as a valid JSON object matching the requested schema. Never output conversational pleasantries or repeated inputs.

Output strictly JSON matching this format:
{
  "insights": ["insight 1", "insight 2"],
  "anomalies": ["anomaly 1"],
  "summary": "..."
}\`;
                analyst.setSystemInstruction(systemInstruction);
                return analyst.run(\`Task: \${task}\\nMetadata: \${JSON.stringify(metadata)}\\nHistorical Baselines: \${historicalContext}\\nData Chunk [\${i + 1}/\${chunks.length}]:\\n\${chunk}\`, context, { responseMimeType: "application/json" });
            });
            
            const chunkReports = await Promise.all(analystPromises);`;

const replacementStr = `            const analystPromises = analysts.map(analyst => {
                const systemInstruction = \`You are a Data Analysis Specialist in a modular swarm.

When given data:
1. PLAN: Check the token weight of the input metadata. Identify 2-3 specific dimensions to investigate.
2. REASON: Analyze differences between current inputs and baselines. Keep internal deductions concise and strictly focused on statistical significance.
3. SANITIZE: Discard raw values and processing traces.
4. EMIT: Return output exclusively as a valid JSON object matching the requested schema. Never output conversational pleasantries or repeated inputs.

Output strictly JSON matching this format:
{
  "insights": ["insight 1", "insight 2"],
  "anomalies": ["anomaly 1"],
  "summary": "..."
}\`;
                analyst.setSystemInstruction(systemInstruction);
                return analyst.run(\`Task: \${task}\\nMetadata: \${JSON.stringify(metadata)}\\nHistorical Baselines: \${historicalContext}\\nData Chunk [\${i + 1}/\${chunks.length}]:\\n\${chunk}\`, context, { responseMimeType: "application/json" })
                    .catch(err => {
                        // Resilient Swarm: Do not let one rate-limited agent crash the whole swarm
                        return {
                            insights: [\`\${analyst.role} was unable to process this chunk due to API constraints.\`],
                            anomalies: [],
                            summary: \`Failed to process: \${err.message || String(err)}\`
                        };
                    });
            });
            
            const chunkReports = await Promise.all(analystPromises);`;

if (server.includes(targetStr)) {
    console.log("Found chunk execution loop. Patching for resilience.");
    server = server.replace(targetStr, replacementStr);
    fs.writeFileSync('server.ts', server);
} else {
    console.log("Could not find chunk execution loop.");
}
