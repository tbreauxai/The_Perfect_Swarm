const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

const oldLogic = `    let finalAnalysis: any = null;

    try {
        const systemInstruction = \`You are the Swarm Orchestrator. Analyze the incoming task and data.
        
Instead of outputting raw text, you MUST output a Generative UI payload.
Output strict JSON in this exact structure (you can use MetricCard, InsightList, and DataTable components):
{
  "ui_title": "Dashboard Title",
  "components": [
    {
      "id": "c1",
      "type": "MetricCard",
      "props": { "title": "...", "value": "...", "subtitle": "...", "trend": "up" }
    },
    {
      "id": "c2",
      "type": "InsightList",
      "props": { "title": "...", "insights": [{ "type": "success|warning|info", "message": "..." }] }
    },
    {
      "id": "c3",
      "type": "DataTable",
      "props": { "title": "...", "columns": [{ "key": "c1", "header": "H1" }], "rows": [{ "c1": "v1" }] }
    }
  ]
}\`;

        managerAgent.setSystemInstruction(systemInstruction);
        const dynamicPrompt = \`Task: \${task}\\nData: \${data || "No data provided"}\`;

        const orchestratorPlan = await managerAgent.run(dynamicPrompt, context, {
            responseMimeType: "application/json"
        });

        try {
            if (typeof orchestratorPlan === "string") {
                const cleanPlan = orchestratorPlan.replace(/^\\\`\\\`\\\`json\\s*/, '').replace(/\\s*\\\`\\\`\\\`$/, '').replace(/^\\\`\\\`\\\`\\s*/, '');
                finalAnalysis = JSON.parse(cleanPlan);
            } else {
                finalAnalysis = orchestratorPlan;
            }
        } catch (e) {
            console.error("JSON Parse error:", e);
            finalAnalysis = { error: "Failed to generate structured UI payload.", raw: orchestratorPlan };
        }


    } catch (swarmErr) {`;

const newLogic = `    let finalAnalysis: any = null;

    try {
        // Step 1: Parser Agent cleans/structures data (Optional but good for swarm architecture)
        parserAgent.setSystemInstruction("You are the Data Parser. Clean, summarize, and structure the incoming data to make it easy for analysts to digest. Keep only the most relevant information.");
        const parsedData = await parserAgent.run(\`Raw Data: \${data || "No data provided"}\`, context);

        // Step 2: Run all Analysts in parallel
        const analystPromises = analysts.map(analyst => {
            analyst.setSystemInstruction(\`You are an expert Analyst. Analyze the data specifically to solve the following task: \${task}. Provide clear, actionable insights.\`);
            return analyst.run(\`Task: \${task}\\nParsed Data: \${parsedData}\`, context);
        });
        
        const analystReports = await Promise.all(analystPromises);
        
        // Compile reports
        let compiledReports = analysts.map((a, i) => \`[\${a.role} Report]:\\n\${analystReports[i]}\`).join('\\n\\n');

        // Step 3: Manager Agent synthesizes into UI Payload
        const systemInstruction = \`You are the Swarm Orchestrator. Synthesize the reports from your specialized Analyst agents into a single unified Generative UI payload.
        
Instead of outputting raw text, you MUST output a Generative UI payload.
Output strict JSON in this exact structure (you can use MetricCard, InsightList, and DataTable components):
{
  "ui_title": "Dashboard Title",
  "components": [
    {
      "id": "c1",
      "type": "MetricCard",
      "props": { "title": "...", "value": "...", "subtitle": "...", "trend": "up" }
    },
    {
      "id": "c2",
      "type": "InsightList",
      "props": { "title": "...", "insights": [{ "type": "success|warning|info", "message": "..." }] }
    },
    {
      "id": "c3",
      "type": "DataTable",
      "props": { "title": "...", "columns": [{ "key": "c1", "header": "H1" }], "rows": [{ "c1": "v1" }] }
    }
  ]
}\`;

        managerAgent.setSystemInstruction(systemInstruction);
        const dynamicPrompt = \`Task: \${task}\\n\\nAnalyst Reports:\\n\${compiledReports}\`;

        const orchestratorPlan = await managerAgent.run(dynamicPrompt, context, {
            responseMimeType: "application/json"
        });

        try {
            if (typeof orchestratorPlan === "string") {
                const cleanPlan = orchestratorPlan.replace(/^\\\`\\\`\\\`json\\s*/, '').replace(/\\s*\\\`\\\`\\\`$/, '').replace(/^\\\`\\\`\\\`\\s*/, '');
                finalAnalysis = JSON.parse(cleanPlan);
            } else {
                finalAnalysis = orchestratorPlan;
            }
        } catch (e) {
            console.error("JSON Parse error:", e);
            finalAnalysis = { error: "Failed to generate structured UI payload.", raw: orchestratorPlan };
        }


    } catch (swarmErr) {`;

// Replace it
code = code.replace(oldLogic, newLogic);
fs.writeFileSync('server.ts', code);
