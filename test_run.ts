import { executeSwarmWorkflow } from './src/services/swarmEngine.js';

async function run() {
  console.log("Starting mock run...");
  const res = await executeSwarmWorkflow({
    task: "Analyze the usage of our new feature",
    data: "Sample data: Users clicked the button 50 times.",
    settings: {
      agents: [
        { id: 'manager', role: 'Manager Node', provider: 'gemini', model: 'gemini-2.5-flash' },
        { id: 'analyst1', role: 'Analyst', provider: 'gemini', model: 'gemini-2.5-flash' }
      ]
    }
  });
  console.log("Final Analysis:", JSON.stringify(res.finalAnalysis, null, 2));
}

run().catch(console.error);
