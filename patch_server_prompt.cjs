const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

const oldPromptStr = `        const orchestratorPrompt = \`You are the Swarm Orchestrator. Analyze the following task and data.
        
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
        }
        
        Task: \${task}
        Data: \${data || "No data provided"}\`;

        const orchestratorPlan = await managerAgent.run(orchestratorPrompt, context, {
            responseMimeType: "application/json"
        });`;

const newPromptStr = `        const systemInstruction = \`You are the Swarm Orchestrator. Analyze the incoming task and data.
        
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
        });`;

code = code.replace(oldPromptStr, newPromptStr);
fs.writeFileSync('server.ts', code);
