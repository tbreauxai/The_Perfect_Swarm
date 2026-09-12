const orchestratorPlan = `{
  "ui_title": "Swarm Architecture Optimization Dashboard",
  "components": [
    {
      "id": "metric-throughput",
      "type": "MetricCard",
      "props": {
        "title": "Projected Throughput Gain",
        "value": "+42%",
        "subtitle": "Via parallel sub-agent execution & payload caching",
        "trend": "up"
      }
    }
  ]
}`;
try {
  let cleaned = orchestratorPlan.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  console.log("Parsed:", JSON.parse(cleaned));
} catch(e) {
  console.error(e);
}
