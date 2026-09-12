const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

const target = `            const analystPromises = analysts.map(analyst => {
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
                analyst.setSystemInstruction(systemInstruction);`;

const replacement = `            const analystPromises = analysts.map(analyst => {
                
                let specialization = "general data analysis and architectural integrity";
                if (analyst.role.includes("Gemini")) {
                    specialization = "deep semantic logic, complex system architecture, and identifying hidden structural patterns";
                } else if (analyst.role.includes("Groq")) {
                    specialization = "high-speed telemetry, performance optimization, and latency bottleneck detection";
                } else if (analyst.role.includes("OpenRouter")) {
                    specialization = "cost-efficiency, token budgeting, and resource utilization strategies";
                } else if (analyst.role.includes("Mistral")) {
                    specialization = "security, compliance, edge-case handling, and strict error thresholding";
                }

                const systemInstruction = \`You are a highly specialized Swarm Analyst. Your unique domain expertise is: \${specialization}.
When given data, view it STRICTLY through the lens of your domain expertise.
1. PLAN: Check the input data. Identify 2-3 specific dimensions related to \${specialization} to investigate.
2. REASON: Analyze differences and trends. Keep deductions concise and strictly focused on your domain.
3. SANITIZE: Discard raw values and processing traces.
4. EMIT: Return output exclusively as a valid JSON object matching the requested schema.
Output strictly JSON matching this format:
{
  "insights": ["<domain-specific insight 1>", "<domain-specific insight 2>"],
  "anomalies": ["<domain-specific anomaly 1>"],
  "summary": "<brief synthesis focused on your domain>"
}\`;
                analyst.setSystemInstruction(systemInstruction);`;

if(code.includes('const systemInstruction = `You are a Data Analysis Specialist in a modular swarm.')) {
    code = code.replace(target, replacement);
    fs.writeFileSync('server.ts', code);
    console.log("Analysts successfully specialized!");
} else {
    console.log("Could not find target block to replace.");
}
